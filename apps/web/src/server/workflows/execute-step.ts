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
//   CLIENT_EMAIL     → schickt E-Mail an alle aktiven Portal-Kontakte und
//                      markiert das Item sofort als done.
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

export async function executeWorkflowStep(opts: ExecuteOpts): Promise<ExecuteResult> {
  const { tenantId, staffId, itemId } = opts;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  // Befund 4: SMTP-Versand NICHT innerhalb der interaktiven Tx (15s-Timeout →
  // P2028-Risiko; Rollback NACH Versand = Doppelversand beim Retry). Der
  // Tx-Callback sammelt die fertig gerenderten Mails nur ein; verschickt wird
  // NACH dem Commit (gleiches Muster wie uploadExternalInvoiceAction).
  const mailJobs: Array<{ to: string; subject: string; text: string; html: string }> = [];
  // M-N2: n8n-Events werden INNERHALB der Tx nur eingesammelt und erst NACH
  // dem Commit gefeuert. `emitN8nEvent` schreibt über prismaOwner (eigene
  // Connection) — ein Feuern vor dem Commit würde bei Rollback ein Event für
  // eine nie existierende Anforderung zustellen bzw. der Worker könnte es vor
  // Sichtbarkeit des Commits verarbeiten (gleiches Muster wie mailJobs).
  const n8nEvents: Array<{ event: N8nEventName; payload: Record<string, unknown> }> = [];

  const result = await withTenantContext(ctx, async (tx) => {
    const item = await tx.workflowItem.findUnique({
      where: { id: itemId },
      include: { instance: { select: { clientId: true, name: true } } },
    });
    if (!item) return { ok: false, error: 'Workflow-Schritt nicht gefunden.' };
    if (item.doneAt) return { ok: false, error: 'Schritt ist bereits erledigt.' };
    if (item.startedAt && item.kind !== 'TASK') {
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
          if (tpl) {
            subjectTpl = tpl.subject;
            bodyTpl = tpl.bodyMd;
          }
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
        await tx.workflowItem.update({
          where: { id: itemId },
          data: { doneAt: new Date(), doneByStaff: staffId },
        });
        result.itemMarkedDone = true;
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

    return result;
  });

  // M-N2: n8n-Events erst nach erfolgreichem Commit feuern.
  if (result.ok) {
    for (const ev of n8nEvents) emitN8nEvent(ev.event, ev.payload, { tenantId });
  }

  // Befund 4: Versand NACH dem Commit. allSettled-Ergebnisse werden jetzt
  // ausgewertet — Fehlschläge strukturiert loggen statt stillschweigend zu
  // verwerfen (vorher: alle Mails fehlgeschlagen → Item trotzdem done, kein Log).
  if (result.ok && mailJobs.length > 0) {
    const settled = await Promise.allSettled(mailJobs.map((j) => sendMail({ ...j, tenantId })));
    const failures = settled
      .map((s, i) => ({ s, to: mailJobs[i]!.to }))
      .filter((x): x is { s: PromiseRejectedResult; to: string } => x.s.status === 'rejected');
    if (failures.length > 0) {
      log.error(
        {
          component: 'workflow-execute-step',
          itemId,
          tenantId,
          failedCount: failures.length,
          totalRecipients: mailJobs.length,
          failures: failures.map((x) => ({
            to: x.to,
            err: (x.s.reason as Error)?.message ?? String(x.s.reason),
          })),
        },
        'CLIENT_EMAIL: Versand an einen oder mehrere Empfänger fehlgeschlagen (Item bereits done)',
      );
    }
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
