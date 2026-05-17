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

import { sendMail, type MailAttachment } from '@/server/mail/send';
import { emitN8nEvent, type N8nEventName } from '@/server/n8n/emit';
import { readMailDispatch } from '@/server/settings/mail-dispatch';
import { prismaOwner } from '@/server/db/prisma-owner';
import { log } from '@/server/logger';
import { renderSafeMarkdown, escapeMarkdownVariable } from '@/server/markdown';

export interface TemplateFallback {
  subject: string;
  bodyMd: string;
}

export interface DispatchOptions {
  tenantId: string;
  /** System-Slug der EmailTemplate (z. B. 'magic-link', 'handover-ready') */
  slug: string;
  /** Variablen für die `{{path.to.var}}`-Substitution */
  vars: Record<string, unknown>;
  /** Empfänger-Adresse */
  to: string;
  /** Optional: Reply-To überschreiben */
  replyTo?: string;
  /** n8n-Event-Name (falls Dispatch-Modus BOTH ist) */
  n8nEvent?: N8nEventName;
  /** n8n-Payload (zusätzlich zu vars; falls n8n eine andere Struktur erwartet) */
  n8nPayload?: Record<string, unknown>;
  /** Fallback wenn Template nicht in DB ist */
  fallback?: TemplateFallback;
  /** Optionale Datei-Anhänge (z. B. PDF-Rechnung) */
  attachments?: MailAttachment[];
}

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
    return opts.forMarkdown ? escapeMarkdownVariable(str) : str;
  });
}

// W-4: markdownToHtml + safeHref sind in @/server/markdown ausgelagert, weil
// auch die UI (z. B. Form-Template-Intro) den safe Renderer benutzt. Lokal
// referenzieren wir nur das Re-Export.
const markdownToHtml = renderSafeMarkdown;

export async function sendTemplateMail(opts: DispatchOptions): Promise<{ ok: boolean; sentViaTemplate: boolean }> {
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
      emitN8nEvent(opts.n8nEvent, opts.n8nPayload ?? opts.vars, { tenantId: opts.tenantId });
    }
    return { ok: false, sentViaTemplate: false };
  }

  try {
    await sendMail({
      tenantId: opts.tenantId,
      to: opts.to,
      subject,
      text: bodyMd,
      html: markdownToHtml(bodyMd),
      replyTo: opts.replyTo,
      attachments: opts.attachments,
    });
  } catch (err) {
    log.error({ slug: opts.slug, err: (err as Error).message }, 'mail: template send failed');
    // n8n trotzdem ansprechen — der könnte Slack-Ping o.ä. auslösen
    if (dispatch.mode === 'BOTH' && opts.n8nEvent) {
      emitN8nEvent(opts.n8nEvent, opts.n8nPayload ?? opts.vars, { tenantId: opts.tenantId });
    }
    return { ok: false, sentViaTemplate };
  }

  if (dispatch.mode === 'BOTH' && opts.n8nEvent) {
    emitN8nEvent(opts.n8nEvent, opts.n8nPayload ?? opts.vars, { tenantId: opts.tenantId });
  }
  return { ok: true, sentViaTemplate };
}

/**
 * Versendet eine Template-Mail an alle aktiven Kontakte eines Mandanten mit
 * eingeschaltetem `notificationsEnabled`. Pro Kontakt werden die Vars
 * mit `contact.fullName` + `contact.email` ergänzt.
 *
 * Skippt komplett, wenn der Mandant keinen aktiven Kontakt mit Mail-Opt-in
 * hat — kein Fehler, weil das eine valide Konfiguration ist (Mandant ohne
 * Portal-Zugang).
 */
export async function notifyClientContacts(opts: Omit<DispatchOptions, 'to'> & {
  clientId: string;
}): Promise<{ ok: boolean; recipients: number }> {
  const contacts = await prismaOwner.clientContact.findMany({
    where: {
      tenantId: opts.tenantId,
      clientId: opts.clientId,
      active: true,
      notificationsEnabled: true,
    },
    select: { fullName: true, email: true },
  });
  if (contacts.length === 0) return { ok: true, recipients: 0 };

  let okCount = 0;
  for (const c of contacts) {
    const res = await sendTemplateMail({
      ...opts,
      to: c.email,
      vars: {
        ...opts.vars,
        contact: { fullName: c.fullName, email: c.email },
      },
    });
    if (res.ok) okCount++;
  }
  return { ok: okCount > 0, recipients: okCount };
}
