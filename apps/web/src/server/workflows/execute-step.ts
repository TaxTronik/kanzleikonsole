// =============================================================================
// executeWorkflowStep
//
// Stößt einen Workflow-Schritt an, abhängig von seinem `kind`. Wird vom
// "Anstoßen"-Button auf der Workflow-Detail-Seite gerufen. Nebeneffekte je
// nach Typ:
//
//   TASK             → markiert das Item sofort als done.
//   DOCUMENT_UPLOAD  → no-op (Erledigung passiert beim Upload, separat).
//   CLIENT_REQUEST   → erzeugt eine Anforderung mit Vorgabe-Inhalt.
//                      Item bleibt offen, bis die Anforderung geschlossen
//                      wird (DB-Trigger setzt dann doneAt).
//   CLIENT_FORM      → erzeugt FormSubmission + verlinkte Anforderung.
//                      Item bleibt offen, bis Mandant Submission abschickt.
//   CLIENT_EMAIL     → beansprucht den Schritt, schickt E-Mail an alle aktiven
//                      Portal-Kontakte und markiert ihn erst nach bestätigtem
//                      Versand als done.
//   N8N_TRIGGER      → nur n8nEvent feuern, dann done.
//
// Zusätzlich: wenn `n8nEvent` gesetzt ist, wird IMMER ein Webhook gefeuert
// (egal welcher Kind). So kann eine Kanzlei z. B. einen `TASK`-Schritt
// trotzdem für eine externe Automation nutzen.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent, type N8nEventName } from '@/server/n8n/emit';
import { renderTemplate } from '@/server/mail/dispatch';
import { sendMail } from '@/server/mail/send';
import { log } from '@/server/logger';

const EMAIL_CLAIM_STALE_MS = 30 * 60 * 1000;

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  /** Was an Folge-Artefakten erzeugt wurde, für UI-Feedback */
  createdRequestId?: string;
  createdSubmissionId?: string;
  /** True wenn das Item nach dem Run als erledigt markiert wurde */
  itemMarkedDone?: boolean;
}

export interface ExecuteOpts {
  tenantId: string;
  staffId: string;
  itemId: string;
}

interface MailJob {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function hasActiveExecutionClaim(kind: string, startedAt: Date | null): boolean {
  if (!startedAt || kind === 'TASK') return false;
  return kind !== 'CLIENT_EMAIL' || startedAt.getTime() > Date.now() - EMAIL_CLAIM_STALE_MS;
}

function resolveEmailTemplate(
  template: { subject: string; bodyMd: string } | null,
  fallback: { subject: string; body: string },
): { subject: string; body: string } {
  if (!template) return fallback;
  return { subject: template.subject, body: template.bodyMd };
}

async function finalizeClientEmail(opts: {
  shouldRun: boolean;
  mailJobs: MailJob[];
  mailClaimedAt: Date | null;
  mailAuditN8nEvent: string | null;
  tenantId: string;
  staffId: string;
  itemId: string;
}): Promise<ExecuteResult | null> {
  const { shouldRun, mailJobs, mailClaimedAt, mailAuditN8nEvent, tenantId, staffId, itemId } = opts;
  if (!shouldRun || mailJobs.length === 0) return null;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const settled = await Promise.allSettled(mailJobs.map((job) => sendMail({ ...job, tenantId })));
  const failures = settled
    .map((result, index) => ({ result, to: mailJobs[index]!.to }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; to: string } =>
        entry.result.status === 'rejected',
    );

  if (failures.length > 0) {
    if (mailClaimedAt) {
      await withTenantContext(ctx, (tx) =>
        tx.workflowItem.updateMany({
          where: { id: itemId, doneAt: null, startedAt: mailClaimedAt },
          data: { startedAt: null },
        }),
      );
    }
    log.error(
      {
        component: 'workflow-execute-step',
        itemId,
        tenantId,
        failedCount: failures.length,
        totalRecipients: mailJobs.length,
        failures: failures.map((entry) => ({
          to: entry.to,
          err: (entry.result.reason as Error)?.message ?? String(entry.result.reason),
        })),
      },
      'CLIENT_EMAIL: Versand fehlgeschlagen (Item bleibt offen)',
    );
    return {
      ok: false,
      error: `E-Mail-Versand an ${failures.length} von ${mailJobs.length} Empfängern fehlgeschlagen. Der Schritt bleibt offen.`,
    };
  }

  if (!mailClaimedAt) {
    return { ok: false, error: 'E-Mail-Schritt konnte nicht eindeutig beansprucht werden.' };
  }

  const completed = await withTenantContext(ctx, async (tx) => {
    const claim = await tx.workflowItem.updateMany({
      where: { id: itemId, doneAt: null, startedAt: mailClaimedAt },
      data: { doneAt: new Date(), doneByStaff: staffId },
    });
    if (claim.count === 0) return false;
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.item.execute',
      resourceType: 'workflow_item',
      resourceId: itemId,
      after: {
        kind: 'CLIENT_EMAIL',
        markedDone: true,
        recipientCount: mailJobs.length,
        n8nEvent: mailAuditN8nEvent,
      },
    });
    return true;
  });

  return completed
    ? { ok: true, itemMarkedDone: true }
    : {
        ok: false,
        error:
          'E-Mail wurde versendet, der Workflow-Schritt konnte aber nicht abgeschlossen werden.',
      };
}

export async function executeWorkflowStep(opts: ExecuteOpts): Promise<ExecuteResult> {
  const { tenantId, staffId, itemId } = opts;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  // Befund 4: SMTP-Versand NICHT innerhalb der interaktiven Tx (15s-Timeout →
  // P2028-Risiko; Rollback NACH Versand = Doppelversand beim Retry). Der
  // Tx-Callback sammelt die fertig gerenderten Mails nur ein; verschickt wird
  // NACH dem Commit (gleiches Muster wie uploadExternalInvoiceAction).
  const mailJobs: MailJob[] = [];
  let mailClaimedAt: Date | null = null;
  let mailAuditN8nEvent: string | null = null;
  // M-N2: n8n-Events werden INNERHALB der Tx nur eingesammelt und erst NACH
  // dem Commit gefeuert. `emitN8nEvent` schreibt über prismaOwner (eigene
  // Connection) — ein Feuern vor dem Commit würde bei Rollback ein Event für
  // eine nie existierende Anforderung zustellen bzw. der Worker könnte es vor
  // Sichtbarkeit des Commits verarbeiten (gleiches Muster wie mailJobs).
  const n8nEvents: Array<{ event: N8nEventName; payload: Record<string, unknown> }> = [];

  const result: ExecuteResult = await withTenantContext(ctx, async (tx) => {
    const item = await tx.workflowItem.findUnique({
      where: { id: itemId },
      include: { instance: { select: { clientId: true, name: true } } },
    });
    if (!item) return { ok: false, error: 'Workflow-Schritt nicht gefunden.' };
    if (item.doneAt) return { ok: false, error: 'Schritt ist bereits erledigt.' };
    if (hasActiveExecutionClaim(item.kind, item.startedAt)) {
      return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
    }

    const clientId = item.instance.clientId;
    const config = (item.config as Record<string, unknown>) ?? {};
    const result: ExecuteResult = { ok: true };

    switch (item.kind) {
      case 'TASK':
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { doneAt: new Date(), doneByStaff: staffId },
        });
        result.itemMarkedDone = true;
        break;

      case 'DOCUMENT_UPLOAD':
        // Erledigung läuft über den Upload-Flow — wir markieren das Item
        // hier nur als „angestoßen" (UI öffnet daraufhin den Upload-Dialog).
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { startedAt: new Date() },
        });
        break;

      case 'CLIENT_REQUEST': {
        // Vorlage hat Vorrang. Inline-Werte greifen nur, wenn keine
        // Vorlage gewählt ist oder die referenzierte Vorlage gelöscht wurde.
        const requestTemplateId =
          typeof config['requestTemplateId'] === 'string' ? config['requestTemplateId'] : null;
        let title = String(config['requestTitle'] ?? item.title);
        let description = String(config['requestDescription'] ?? item.description ?? '');
        let priority = (config['priority'] as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT') ?? 'NORMAL';
        let dueAfterDays =
          typeof config['dueAfterDays'] === 'number' ? config['dueAfterDays'] : null;
        let formSubmissionId: string | null = null;

        if (requestTemplateId) {
          const tpl = await tx.requestTemplate.findUnique({ where: { id: requestTemplateId } });
          if (tpl) {
            title = tpl.title;
            description = tpl.description;
            priority = tpl.priority;
            if (tpl.dueAfterDays != null) dueAfterDays = tpl.dueAfterDays;
            // Wenn die RequestTemplate ein Formular hat, legen wir die
            // Submission gleich an.
            if (tpl.formTemplateId) {
              const sub = await tx.formSubmission.create({
                data: {
                  tenantId,
                  templateId: tpl.formTemplateId,
                  clientId,
                  name: title,
                  workflowItemId: itemId,
                  createdByStaff: staffId,
                },
              });
              formSubmissionId = sub.id;
              result.createdSubmissionId = sub.id;
            }
          }
        }

        const dueAt =
          dueAfterDays != null ? new Date(Date.now() + dueAfterDays * 24 * 60 * 60 * 1000) : null;

        const req = await tx.request.create({
          data: {
            tenantId,
            clientId,
            title,
            description,
            priority,
            dueAt,
            workflowItemId: itemId,
            formSubmissionId,
            createdByStaff: staffId,
          },
        });
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { startedAt: new Date() },
        });
        result.createdRequestId = req.id;
        break;
      }

      case 'CLIENT_FORM': {
        const formTemplateId = String(config['formTemplateId'] ?? '');
        if (!formTemplateId) return { ok: false, error: 'Schritt enthält keine Formular-Vorlage.' };
        const tpl = await tx.formTemplate.findUnique({ where: { id: formTemplateId } });
        if (!tpl) return { ok: false, error: 'Formular-Vorlage nicht gefunden.' };
        if (!tpl.active) return { ok: false, error: 'Formular-Vorlage ist deaktiviert.' };

        const sub = await tx.formSubmission.create({
          data: {
            tenantId,
            templateId: formTemplateId,
            clientId,
            name: tpl.name,
            workflowItemId: itemId,
            createdByStaff: staffId,
          },
        });
        const req = await tx.request.create({
          data: {
            tenantId,
            clientId,
            title: String(config['requestTitle'] ?? `Formular: ${tpl.name}`),
            description: String(config['requestDescription'] ?? ''),
            priority: 'NORMAL',
            formSubmissionId: sub.id,
            workflowItemId: itemId,
            createdByStaff: staffId,
          },
        });
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { startedAt: new Date() },
        });
        result.createdRequestId = req.id;
        result.createdSubmissionId = sub.id;
        break;
      }

      case 'CLIENT_EMAIL': {
        const emailTemplateId =
          typeof config['emailTemplateId'] === 'string' ? config['emailTemplateId'] : null;
        let subjectTpl = String(config['subject'] ?? item.title);
        let bodyTpl = String(config['bodyMd'] ?? '');
        if (emailTemplateId) {
          const tpl = await tx.emailTemplate.findUnique({ where: { id: emailTemplateId } });
          const resolved = resolveEmailTemplate(tpl, { subject: subjectTpl, body: bodyTpl });
          subjectTpl = resolved.subject;
          bodyTpl = resolved.body;
        }
        const client = await tx.client.findUnique({
          where: { id: clientId },
          select: { name: true },
        });
        const contacts = await tx.clientContact.findMany({
          where: { clientId, active: true, notificationsEnabled: true, email: { not: '' } },
          select: { email: true, fullName: true },
        });
        if (contacts.length === 0) {
          return {
            ok: false,
            error: 'Mandant hat keinen aktiven Portal-Kontakt mit E-Mail-Opt-in.',
          };
        }
        // Pro Kontakt mit eigenen Vars rendern (contact.fullName ist
        // empfänger-spezifisch, alles andere identisch). Befund 4: hier nur
        // RENDERN und einsammeln — der Versand passiert nach dem Tx-Commit.
        for (const c of contacts) {
          const vars = {
            contact: { fullName: c.fullName, email: c.email },
            client: { name: client?.name ?? '' },
            step: { title: item.title },
          };
          mailJobs.push({
            to: c.email,
            subject: renderTemplate(subjectTpl, vars),
            text: renderTemplate(bodyTpl, vars),
            html: markdownToInlineHtml(renderTemplate(bodyTpl, vars)),
          });
        }
        const claimedAt = new Date();
        const staleBefore = new Date(claimedAt.getTime() - EMAIL_CLAIM_STALE_MS);
        const claim = await tx.workflowItem.updateMany({
          where: {
            id: itemId,
            doneAt: null,
            OR: [{ startedAt: null }, { startedAt: { lte: staleBefore } }],
          },
          data: { startedAt: claimedAt },
        });
        if (claim.count === 0) {
          return { ok: false, error: 'E-Mail-Versand läuft bereits oder wurde abgeschlossen.' };
        }
        mailClaimedAt = claimedAt;
        mailAuditN8nEvent = item.n8nEvent;
        break;
      }

      case 'N8N_TRIGGER':
        // n8nEvent wird unten geFEUERT — Item ist sofort erledigt.
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { doneAt: new Date(), doneByStaff: staffId },
        });
        result.itemMarkedDone = true;
        break;
    }

    // n8n-Event einsammeln (für alle Kinds — wenn gesetzt); gefeuert wird nach
    // dem Commit (M-N2). F8: item.n8nEvent ist beim Save via Regex auf
    // [a-z0-9._-]{1,41} begrenzt → `workflow.step.${...}` ist im
    // WorkflowStepN8nEvent-Template-Type, kein unsafe-Cast nötig.
    if (item.n8nEvent) {
      // M-N6: der beim N8N_TRIGGER validierte `payload` (step-config) wird
      // jetzt tatsächlich mitgegeben (vorher kommentarlos verworfen).
      const customPayload =
        item.kind === 'N8N_TRIGGER' && config['payload'] && typeof config['payload'] === 'object'
          ? (config['payload'] as Record<string, unknown>)
          : undefined;
      n8nEvents.push({
        event: `workflow.step.${item.n8nEvent}`,
        payload: {
          tenantId,
          itemId,
          clientId,
          kind: item.kind,
          title: item.title,
          createdRequestId: result.createdRequestId,
          createdSubmissionId: result.createdSubmissionId,
          ...(customPayload ? { custom: customPayload } : {}),
        },
      });
    }

    // CLIENT_EMAIL wird erst nach dem tatsächlichen Versand auditiert und
    // abgeschlossen. Bei allen anderen Typen ist der fachliche Effekt bereits
    // innerhalb dieser Transaktion vollständig.
    if (item.kind !== 'CLIENT_EMAIL') {
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.item.execute',
        resourceType: 'workflow_item',
        resourceId: itemId,
        after: {
          kind: item.kind,
          markedDone: result.itemMarkedDone ?? false,
          createdRequestId: result.createdRequestId ?? null,
          createdSubmissionId: result.createdSubmissionId ?? null,
          n8nEvent: item.n8nEvent ?? null,
        },
      });
    }

    return result;
  });

  // Versand NACH dem Claim-Commit. Das Item wird erst dann erledigt, wenn alle
  // Empfänger erfolgreich an SMTP übergeben wurden. Bei einem Fehler geben wir
  // den Claim wieder frei, damit der Versand bewusst erneut versucht werden kann.
  const mailResult = await finalizeClientEmail({
    shouldRun: result.ok,
    mailJobs,
    mailClaimedAt,
    mailAuditN8nEvent,
    tenantId,
    staffId,
    itemId,
  });
  if (mailResult) {
    if (!mailResult.ok) return mailResult;
    result.itemMarkedDone = true;
  }

  // n8n-Events erst nach erfolgreichem Fachabschluss feuern. Bei CLIENT_EMAIL
  // bedeutet das ausdrücklich: erst nach bestätigtem Mailversand.
  if (result.ok) {
    await Promise.all(
      n8nEvents.map((event) => emitN8nEvent(event.event, event.payload, { tenantId })),
    );
  }

  return result;
}

/**
 * Minimaler Markdown→HTML-Mapper für E-Mail-Versand. Macht nur Zeilenumbrüche
 * + Absätze; keine ausgefeilte Markdown-Library, weil n8n / unsere Vorlagen
 * meist Plaintext sind.
 */
function markdownToInlineHtml(md: string): string {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = esc.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);
  return `<!doctype html><html><body>${paragraphs.join('')}</body></html>`;
}
