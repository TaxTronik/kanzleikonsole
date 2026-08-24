// =============================================================================
// Mail-Dispatch — App-Versand über EmailTemplate + optional n8n-Side-Effect
//
// Zentrale Stelle, an der die App ausgehende Mails verschickt. Lädt die
// passende Vorlage aus der DB (nach `slug`), substituiert `{{var.path}}`-
// Platzhalter im Subject + Body und versendet via App-SMTP. Wenn der Tenant
// `mail.dispatch = 'BOTH'` konfiguriert hat, wird zusätzlich ein n8n-Event
// emittiert — primärer Versand bleibt aber immer die App.
//
// Fallback: Wenn die Vorlage zum slug nicht existiert oder deaktiviert
// wurde, gibt es einen optionalen `fallback` mit hartcodiertem
// subject + body — keine Verlorene Mail nur weil ein Admin
// versehentlich gelöscht hat.
// =============================================================================

import { prismaOwner } from '@taxtronik/db';
import type { N8nEventName } from '@taxtronik/n8n-shared';
import { sendMail, type MailAttachment } from './send';
import { readMailDispatch } from './dispatch-settings';
import { mailLog } from './logger';
import { emitViaConfiguredN8n } from './n8n-emitter';
import { renderSafeMarkdown, escapeMarkdownVariable } from './markdown';

export interface TemplateFallback {
  subject: string;
  bodyMd: string;
}

export interface DispatchOptions {
  tenantId: string;
  /** Mandant, dessen Kontext bei mehrfach belegter Empfängeradresse in den Betreff gehört. */
  clientId?: string;
  /** System-Slug der EmailTemplate (z. B. 'magic-link', 'handover-ready') */
  slug: string;
  /** Variablen für die `{{path.to.var}}`-Substitution */
  vars: Record<string, unknown>;
  /** Empfänger-Adresse */
  to: string;
  /** Optional: Reply-To überschreiben */
  replyTo?: string;
  /** Optionaler Mandanten-/Profilkontext, der dem Betreff angehängt wird. */
  subjectSuffix?: string;
  /** n8n-Event-Name (falls Dispatch-Modus BOTH ist) */
  n8nEvent?: N8nEventName;
  /** n8n-Payload (zusätzlich zu vars; falls n8n eine andere Struktur erwartet) */
  n8nPayload?: Record<string, unknown>;
  /** Fallback wenn Template nicht in DB ist */
  fallback?: TemplateFallback;
  /** Optionale Datei-Anhänge (z. B. PDF-Rechnung) */
  attachments?: MailAttachment[];
}

export interface ContactNotificationResult {
  /** Mindestens ein Mail-Einzelversuch wurde vom SMTP-Provider angenommen. */
  ok: boolean;
  /** Zahl der vom SMTP-Provider angenommenen Einzelversuche. */
  recipients: number;
  /** Zahl der adressierten Kontakte. */
  attempted: number;
  /**
   * Ein nachgelagerter, nicht empfängerbezogener Side-Effect (derzeit n8n)
   * wurde erfolgreich ausgelöst. Bei Mail-Totalfehler darf dann nicht blind
   * erneut versucht werden, weil der externe Workflow bereits gelaufen ist.
   */
  externalSideEffectOccurred: boolean;
  /**
   * Mindestens ein SMTP-Versuch endete mit einer Exception ohne explizite
   * Provider-Ablehnung. Nach moeglicher Annahme darf ein Aufrufer dann nicht
   * automatisch erneut senden.
   */
  uncertainFailure: boolean;
}

export interface TemplateMailResult {
  ok: boolean;
  sentViaTemplate: boolean;
  /** Siehe `ContactNotificationResult.uncertainFailure`. */
  uncertainFailure: boolean;
}

/**
 * System-generierte URL-Variablen (Portal-Links, Magic-Links). Diese Werte
 * stammen ausschließlich aus portalBaseUrl + App-Routen — sie dürfen NICHT
 * durch escapeMarkdownVariable laufen: dessen Anti-Phishing-Sentinel (U+E005
 * zwischen `https:` und `//`) würde (a) den Autolink im HTML-Teil bewusst
 * deaktivieren (kein klickbarer Link) und (b) im text/plain-Teil ein
 * unsichtbares Zeichen mitten im URL-Schema hinterlassen — Mail-Clients und
 * Link-Rewriter (Outlook, SafeLinks) erzeugen daraus kaputte URLs → 404.
 */
const TRUSTED_URL_VARS: ReadonlySet<string> = new Set(['link', 'portalUrl']);
const SAFE_ABSOLUTE_URL = /^https?:\/\/[^\s<>"'`]+$/;

/**
 * Mustache-light: ersetzt `{{path.to.var}}` mit dem entsprechenden Wert aus
 * `vars`. Verschachtelte Objekte werden punktiert dereferenziert.
 * Fehlende Werte werden als leerer String ersetzt (keine harte Fehler-
 * meldung, damit ein vergessenes Feld nicht die ganze Mail verliert).
 *
 * M-2: `forMarkdown=true` escapt Variablen-Werte vor der Substitution, sodass
 * Mandanten-Inputs (z. B. „**Müller**" als Firmenname) NICHT vom
 * Markdown-Renderer interpretiert werden. Subject-Pfad braucht das nicht
 * (plain-text), Body-Pfad schon. Existierende Caller dieser Funktion ohne
 * Flag verhalten sich unverändert.
 *
 * Ausnahme: Variablen aus TRUSTED_URL_VARS, deren Wert eine wohlgeformte
 * absolute http(s)-URL ist, bleiben unescapt, damit der Autolinker im
 * HTML-Teil einen echten Hyperlink erzeugt und der Text-Teil sauber bleibt.
 * Werte, die NICHT wie eine URL aussehen, werden trotzdem escapt
 * (fail-closed, falls je User-Input unter diesen Namen landet).
 */
export function renderTemplate(
  source: string,
  vars: Record<string, unknown>,
  opts: { forMarkdown?: boolean } = {},
): string {
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.');
    let value: unknown = vars;
    for (const p of parts) {
      if (value && typeof value === 'object' && p in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[p];
      } else {
        return '';
      }
    }
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (!opts.forMarkdown) return str;
    if (TRUSTED_URL_VARS.has(path) && SAFE_ABSOLUTE_URL.test(str)) return str;
    return escapeMarkdownVariable(str);
  });
}

/**
 * Bereinigt den text/plain-Teil vor dem Versand: interne Sentinel-/PUA-Zeichen
 * entfernen und Markdown-Backslash-Escapes zurücknehmen. Der HTML-Pfad macht
 * das im Renderer selbst; der Text-Teil ging bisher roh raus — mit U+E005 im
 * URL-Schema und `\_` in base64url-Tokens (kaputte Links in Plaintext-Clients).
 */
export function plainTextBody(bodyMd: string): string {
  return bodyMd.replace(/[-]/g, '').replace(/\\([\\*_[\]])/g, '$1');
}

// W-4: markdownToHtml + safeHref sind in @/server/markdown ausgelagert, weil
// auch die UI (z. B. Form-Template-Intro) den safe Renderer benutzt. Lokal
// referenzieren wir nur das Re-Export.
const markdownToHtml = renderSafeMarkdown;

async function resolveProfileSubjectSuffix(opts: DispatchOptions): Promise<string | undefined> {
  if (!opts.clientId) return undefined;

  const [client, profiles] = await Promise.all([
    prismaOwner.client.findFirst({
      where: { id: opts.clientId, tenantId: opts.tenantId },
      select: { name: true },
    }),
    prismaOwner.clientContact.findMany({
      where: {
        tenantId: opts.tenantId,
        email: opts.to.toLowerCase(),
        active: true,
        client: { allowActive: true, anonymizedAt: null },
      },
      select: { clientId: true },
    }),
  ]);
  if (!client) return undefined;

  // Auch Einladungs-/Rechnungsadressen koennen vor dem ersten Kontakt-Datensatz
  // versendet werden. Der aktuelle Mandant zaehlt deshalb explizit mit.
  const clientIds = new Set(profiles.map((profile) => profile.clientId));
  clientIds.add(opts.clientId);
  return clientIds.size > 1 ? client.name : undefined;
}

export async function sendTemplateMail(opts: DispatchOptions): Promise<TemplateMailResult> {
  const dispatch = await readMailDispatch({
    tenantId: opts.tenantId,
    actorId: null,
    actorType: 'SYSTEM',
  });

  const tpl = await prismaOwner.emailTemplate.findFirst({
    where: { tenantId: opts.tenantId, slug: opts.slug, active: true },
    select: { subject: true, bodyMd: true },
  });

  let subject: string;
  let bodyMd: string;
  let sentViaTemplate = false;
  // N8: subject hat hier theoretisch CRLF-Injection-Risiko, weil
  // renderTemplate() User-Variablen interpoliert. CRLF-Stripping passiert
  // zentral in sendMail() via stripHeaderInjection — siehe
  // apps/web/src/server/mail/send.ts. Hier nur Template-Rendering, kein
  // zweiter Sanitizer (single source of truth).
  if (tpl) {
    // M-2: bodyMd geht durch den Markdown-Renderer, also Variablen escapen.
    // subject ist plain-text, kein Escape nötig.
    subject = renderTemplate(tpl.subject, opts.vars);
    bodyMd = renderTemplate(tpl.bodyMd, opts.vars, { forMarkdown: true });
    sentViaTemplate = true;
  } else if (opts.fallback) {
    subject = renderTemplate(opts.fallback.subject, opts.vars);
    bodyMd = renderTemplate(opts.fallback.bodyMd, opts.vars, { forMarkdown: true });
  } else {
    // Weder Template noch Fallback — Mail nicht versendet, n8n trotzdem
    // ansprechen falls aktiv (nutzt bestehende Workflows).
    if (dispatch.mode === 'BOTH' && opts.n8nEvent) {
      await emitViaConfiguredN8n(opts.n8nEvent, opts.n8nPayload ?? opts.vars, {
        tenantId: opts.tenantId,
      });
    }
    return { ok: false, sentViaTemplate: false, uncertainFailure: false };
  }

  const subjectSuffix = (
    opts.subjectSuffix !== undefined ? opts.subjectSuffix : await resolveProfileSubjectSuffix(opts)
  )?.trim();
  if (
    subjectSuffix &&
    !subject.toLocaleLowerCase('de-DE').includes(subjectSuffix.toLocaleLowerCase('de-DE'))
  ) {
    subject = `${subject} (${subjectSuffix})`;
  }

  try {
    await sendMail({
      tenantId: opts.tenantId,
      to: opts.to,
      subject,
      text: plainTextBody(bodyMd),
      html: markdownToHtml(bodyMd),
      replyTo: opts.replyTo,
      attachments: opts.attachments,
    });
  } catch (err) {
    mailLog().error({ slug: opts.slug, err: (err as Error).message }, 'mail: template send failed');
    // n8n trotzdem ansprechen — der könnte Slack-Ping o.ä. auslösen
    if (dispatch.mode === 'BOTH' && opts.n8nEvent) {
      await emitViaConfiguredN8n(opts.n8nEvent, opts.n8nPayload ?? opts.vars, {
        tenantId: opts.tenantId,
      });
    }
    return {
      ok: false,
      sentViaTemplate,
      // TAX-DEADLINE-AUTOREQUEST-001: Nur eine explizite negative SMTP-
      // Antwort beweist hier hinreichend, dass der Provider die Nachricht
      // nicht angenommen hat. Transport-/Socket-/Timeout-Exceptions bleiben
      // wegen moeglicher Annahme vor dem Verbindungsabbruch fail-closed.
      uncertainFailure: !isExplicitSmtpRejection(err),
    };
  }

  if (dispatch.mode === 'BOTH' && opts.n8nEvent) {
    await emitViaConfiguredN8n(opts.n8nEvent, opts.n8nPayload ?? opts.vars, {
      tenantId: opts.tenantId,
    });
  }
  return { ok: true, sentViaTemplate, uncertainFailure: false };
}

function isExplicitSmtpRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const responseCode = (error as { responseCode?: unknown }).responseCode;
  return (
    typeof responseCode === 'number' &&
    Number.isInteger(responseCode) &&
    responseCode >= 400 &&
    responseCode <= 599
  );
}

/**
 * Versendet eine Template-Mail an alle aktiven Kontakte eines Mandanten mit
 * eingeschaltetem `notificationsEnabled`. Pro Kontakt werden die Vars
 * mit `contact.fullName` + `contact.email` ergänzt.
 *
 * Skippt den SMTP-Pfad, wenn der Mandant keinen aktiven, bereits per
 * erfolgreichem Portal-Login bestätigten Kontakt mit Mail-Opt-in hat. Ein
 * konfiguriertes vorgangsbezogenes n8n-Ereignis wird davon getrennt weiterhin
 * einmal ausgelöst. Der Einladungsversand bleibt ein eigener Pfad; fachliche
 * Mails gehen nicht an eine lediglich eingetragene, unbestätigte Adresse.
 */
export async function notifyClientContacts(
  opts: Omit<DispatchOptions, 'to'> & {
    clientId: string;
  },
): Promise<ContactNotificationResult> {
  const contacts = await prismaOwner.clientContact.findMany({
    where: {
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      active: true,
      notificationsEnabled: true,
      lastLoginAt: { not: null },
      client: { allowActive: true, anonymizedAt: null },
    },
    select: { fullName: true, email: true },
  });

  // Das n8n-Ereignis beschreibt den fachlichen Vorgang, nicht einen einzelnen
  // Empfänger. Es wird deshalb je Aufruf genau einmal emittiert, auch wenn kein
  // aktiver Mailkontakt existiert. `attempted = 0` bleibt davon getrennt die
  // wahrheitsgemaesse Aussage ueber den SMTP-Pfad.
  const aggregateDispatch = opts.n8nEvent
    ? await readMailDispatch({
        tenantId: opts.tenantId,
        actorId: null,
        actorType: 'SYSTEM',
      })
    : null;
  let externalSideEffectOccurred = false;

  if (contacts.length === 0) {
    if (aggregateDispatch?.mode === 'BOTH' && opts.n8nEvent) {
      await emitViaConfiguredN8n(opts.n8nEvent, opts.n8nPayload ?? opts.vars, {
        tenantId: opts.tenantId,
      });
      externalSideEffectOccurred = true;
    }
    return {
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred,
      uncertainFailure: false,
    };
  }

  const emailKeys = Array.from(new Set(contacts.map((contact) => contact.email.toLowerCase())));
  const [client, profilesWithSameEmail] = await Promise.all([
    prismaOwner.client.findFirst({
      where: { id: opts.clientId, tenantId: opts.tenantId },
      select: { name: true },
    }),
    prismaOwner.clientContact.findMany({
      where: {
        tenantId: opts.tenantId,
        email: { in: emailKeys },
        active: true,
        client: { allowActive: true, anonymizedAt: null },
      },
      select: { email: true, clientId: true },
    }),
  ]);
  const profileCountByEmail = new Map<string, Set<string>>();
  for (const profile of profilesWithSameEmail) {
    const emailKey = profile.email.toLowerCase();
    const clientIds = profileCountByEmail.get(emailKey) ?? new Set<string>();
    clientIds.add(profile.clientId);
    profileCountByEmail.set(emailKey, clientIds);
  }

  const existingClientVars =
    opts.vars.client && typeof opts.vars.client === 'object' && !Array.isArray(opts.vars.client)
      ? (opts.vars.client as Record<string, unknown>)
      : {};

  let okCount = 0;
  let uncertainFailure = false;
  for (const c of contacts) {
    const hasMultipleProfiles = (profileCountByEmail.get(c.email.toLowerCase())?.size ?? 0) > 1;
    const res = await sendTemplateMail({
      ...opts,
      // Der vorgangsbezogene Side-Effect wird nach der Schleife einmalig
      // ausgelöst; sendTemplateMail darf ihn nicht je Kontakt emittieren.
      n8nEvent: undefined,
      n8nPayload: undefined,
      to: c.email,
      subjectSuffix: opts.subjectSuffix ?? (hasMultipleProfiles ? client?.name : ''),
      vars: {
        ...opts.vars,
        client: { ...existingClientVars, name: client?.name ?? '' },
        contact: { fullName: c.fullName, email: c.email },
      },
    });
    if (res.ok) okCount++;
    if (res.uncertainFailure) uncertainFailure = true;
  }

  if (aggregateDispatch?.mode === 'BOTH' && opts.n8nEvent) {
    await emitViaConfiguredN8n(opts.n8nEvent, opts.n8nPayload ?? opts.vars, {
      tenantId: opts.tenantId,
    });
    externalSideEffectOccurred = true;
  }

  // `recipients` bleibt aus Kompatibilitaetsgruenden die Zahl der vom
  // Provider angenommenen Einzelversuche. `attempted` macht erstmals
  // unterscheidbar, ob gar kein Empfaenger vorhanden war, alle Versuche
  // scheiterten oder nur ein Teil angenommen wurde.
  return {
    ok: okCount > 0,
    recipients: okCount,
    attempted: contacts.length,
    externalSideEffectOccurred,
    uncertainFailure,
  };
}
