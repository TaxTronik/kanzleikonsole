// =============================================================================
// SMTP-Mail-Helper
//
// Verwendet (falls vorhanden) die tenant-spezifische SMTP-Konfiguration aus
// `tenant_setting.mail.smtp` (verschlüsseltes Passwort, in der UI gepflegt).
// Andernfalls Fallback auf die ENV-Werte (SMTP_HOST/PORT/USER/PASSWORD/FROM).
//
// Im Dev: MailHog (siehe docker-compose) — UI auf http://localhost:8025
//
// Hinweis: n8n übernimmt komplexe Workflows (Reminder-Eskalation, Mahnungen).
// Diese Helper sind für transaktionale Mails, die direkt aus dem App-Code
// versendet werden müssen (z. B. Magic-Link beim Login-Request).
// =============================================================================

import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '@taxtronik/config';
import { readSmtpConfig, type SmtpConfig } from '@/server/settings/smtp';

let envTransporter: Transporter | null = null;

// LRU-Cache für Tenant-Transporter (N6).
// Map preserviert Insertion-Order; bei put() existing entry → delete+set (move
// to MRU). Bei Überschreitung: ersten Eintrag entfernen (LRU). 32 ist großzügig
// für realistische On-Prem-Setups (eine Kanzlei = 1 Tenant) und limitiert
// zugleich den Worst-Case (Multi-Tenant-Demos, Settings-Hot-Reloads).
const TENANT_TRANSPORTER_LRU_MAX = 32;
const tenantTransporters = new Map<string, { signature: string; t: Transporter }>();

function lruClose(t: Transporter): void {
  try {
    t.close();
  } catch {
    // nodemailer.close ist best-effort; Ressource-Leaks im Crash-Pfad sind
    // akzeptabel
  }
}

function lruEvictIfNeeded(): void {
  if (tenantTransporters.size <= TENANT_TRANSPORTER_LRU_MAX) return;
  // Map.keys() in Insertion-Order → erste Key ist LRU
  const oldest = tenantTransporters.keys().next().value;
  if (!oldest) return;
  const evicted = tenantTransporters.get(oldest);
  tenantTransporters.delete(oldest);
  if (evicted) lruClose(evicted.t);
}

function envSmtp(): SmtpConfig {
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    user: env.SMTP_USER ?? '',
    password: env.SMTP_PASSWORD ?? '',
    from: env.SMTP_FROM,
    replyTo: '',
  };
}

function transporterFor(cfg: SmtpConfig): Transporter {
  const isImplicitTls = cfg.secure || cfg.port === 465;
  const isDevMailhog =
    env.NODE_ENV !== 'production' &&
    cfg.port === 1025 &&
    ['localhost', '127.0.0.1', 'mailhog'].includes(cfg.host.toLowerCase());
  // U-2: STARTTLS erzwingen für Port 587 (Submission). Vorher fiel Nodemailer
  // im opportunistischen Modus auf Klartext zurück, wenn der SMTP-Server kein
  // STARTTLS ankündigt (oder ein MitM die Ankündigung stripped). Folge: AUTH-
  // Header inkl. Passwort plain.
  //   - Port 25: Mail-Relay zwischen Servern. requireTLS würde legitime MX-
  //     Relays brechen — bewusst nicht erzwingen.
  //   - Dev-MailHog auf localhost:1025 spricht absichtlich kein STARTTLS.
  //   - Port 465: Implicit TLS — STARTTLS-Flag irrelevant.
  //   - Port 587 / alles andere: requireTLS=true.
  // tls.minVersion: TLS 1.0/1.1 verbieten — SHA-1/RC4-Ciphers raus.
  const requireTLS = !isImplicitTls && cfg.port !== 25 && !isDevMailhog;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: isImplicitTls,
    requireTLS,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    tls: {
      // rejectUnauthorized ist Default true; explizit für die Code-Review.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
  });
}

function transporterSignature(cfg: SmtpConfig): string {
  return [cfg.host, cfg.port, cfg.secure, cfg.user, cfg.password.length, cfg.from].join('|');
}

function getEnvTransporter(): Transporter {
  if (envTransporter) return envTransporter;
  envTransporter = transporterFor(envSmtp());
  return envTransporter;
}

function getTenantTransporter(tenantId: string, cfg: SmtpConfig): Transporter {
  const sig = transporterSignature(cfg);
  const cached = tenantTransporters.get(tenantId);
  if (cached) {
    if (cached.signature === sig) {
      // LRU-Touch: aus Map löschen + neu einfügen → ans Ende (MRU)
      tenantTransporters.delete(tenantId);
      tenantTransporters.set(tenantId, cached);
      return cached.t;
    }
    // Config geändert (Settings-Update) — alten Transporter schließen, sonst
    // bleiben SMTP-Connections offen bis GC.
    lruClose(cached.t);
    tenantTransporters.delete(tenantId);
  }
  const t = transporterFor(cfg);
  tenantTransporters.set(tenantId, { signature: sig, t });
  lruEvictIfNeeded();
  return t;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Datei-Anhänge (z. B. PDF-Rechnung im EXTERNAL-Modus) */
  attachments?: MailAttachment[];
  /**
   * Wenn gesetzt: tenant-spezifische Konfiguration aus `tenant_setting` lesen.
   * Sonst: ENV-Fallback. Empfohlen für Mandanten-spezifische Mails (Magic-
   * Link, PoA-Einladung, Anforderungs-Reminder).
   */
  tenantId?: string;
}

/**
 * Defense in Depth gegen SMTP-Header-Injection (N4): bricht alle CR/LF aus
 * Subject und User-kontrollierten Header-Werten (to, replyTo) heraus. Nodemailer
 * escaped grundsätzlich selbst, aber wir wollen nicht ausschließlich darauf
 * vertrauen — Templates können Variablen mit Zeilenumbruch enthalten.
 */
function stripHeaderInjection(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

export async function sendMail(opts: MailOptions): Promise<void> {
  let dbCfg: SmtpConfig | null = null;
  if (opts.tenantId) {
    try {
      dbCfg = await readSmtpConfig({
        tenantId: opts.tenantId,
        actorId: null,
        actorType: 'SYSTEM',
      });
    } catch {
      dbCfg = null;
    }
  }
  const useDb = Boolean(dbCfg && dbCfg.host && dbCfg.from);
  const finalCfg: SmtpConfig = useDb && dbCfg ? dbCfg : envSmtp();
  const t =
    useDb && opts.tenantId ? getTenantTransporter(opts.tenantId, finalCfg) : getEnvTransporter();

  const safeReplyTo = opts.replyTo
    ? stripHeaderInjection(opts.replyTo)
    : finalCfg.replyTo
      ? stripHeaderInjection(finalCfg.replyTo)
      : undefined;

  await t.sendMail({
    // N5: from durch stripHeaderInjection — Tenant-Admin-konfigurierbar via
    // tenant_setting.mail.smtp.from. Ohne Filter könnten CRLF zusätzliche
    // Header (Bcc, MIME) injizieren. Defense-in-Depth, gleiche Behandlung
    // wie alle anderen User-supplied-Adressen.
    from: stripHeaderInjection(finalCfg.from),
    to: stripHeaderInjection(opts.to),
    subject: stripHeaderInjection(opts.subject),
    text: opts.text,
    html: opts.html,
    replyTo: safeReplyTo,
    attachments: opts.attachments?.map((a) => ({
      filename: stripHeaderInjection(a.filename),
      content: a.content,
      contentType: a.contentType,
    })),
  });
}

/**
 * Versendet eine Test-Mail mit der übergebenen Konfiguration, OHNE sie zu
 * speichern. Wird vom Settings-„Test-Mail senden"-Button benutzt, damit der
 * Admin sieht, ob die Eingaben stimmen, bevor er speichert.
 */
export async function sendTestMail(cfg: SmtpConfig, to: string): Promise<void> {
  // Ad-hoc-Transporter (nicht aus dem Tenant-LRU): nach dem Test schließen,
  // sonst bleiben die gepoolten SMTP-Connections bis zum GC offen — pro
  // „Test-Mail senden"-Klick eine weitere.
  const t = transporterFor(cfg);
  try {
    await t.sendMail({
      // N5: gleicher Filter wie in sendMail.
      from: stripHeaderInjection(cfg.from),
      to: stripHeaderInjection(to),
      subject: 'taxtronik — SMTP-Test',
      text:
        `Diese Test-Mail bestätigt, dass die SMTP-Einstellungen funktionieren.\n\n` +
        `Host: ${cfg.host}:${cfg.port}\n` +
        `Verschlüsselung: ${cfg.secure ? 'SSL/TLS' : 'STARTTLS opportunistisch'}\n` +
        `Absender: ${cfg.from}\n\n` +
        `Wenn diese Mail in einer echten Inbox angekommen ist, können Sie die ` +
        `Einstellungen speichern.\n`,
    });
  } finally {
    t.close();
  }
}
