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

import { readBooleanTenantModules, withTenantContext, type TxClient } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { emitN8nEvent, type N8nEventName } from '@/server/n8n/emit';
import { renderTemplate } from '@/server/mail/dispatch';
import { sendMail } from '@/server/mail/send';
import { log } from '@/server/logger';

const EMAIL_CLAIM_STALE_MS = 30 * 60 * 1000;
const N8N_CLAIM_STALE_MS = 30 * 60 * 1000;

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
  recipientId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface RecipientSnapshot {
  itemId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

interface ClientEmailStepOpts {
  tx: TxClient;
  itemId: string;
  clientId: string;
  itemTitle: string;
  config: Record<string, unknown>;
}

interface ClientEmailPreparation {
  result: ExecuteResult;
  mailJobs: MailJob[];
  claimedAt: Date | null;
}

interface N8nDispatchJob {
  dispatchId: string;
  actorStaffId: string;
  event: N8nEventName;
  payload: Record<string, unknown>;
}

function hasActiveExecutionClaim(kind: string, startedAt: Date | null): boolean {
  if (!startedAt) return false;
  if (kind === 'CLIENT_EMAIL') {
    return startedAt.getTime() > Date.now() - EMAIL_CLAIM_STALE_MS;
  }
  if (kind === 'N8N_TRIGGER') {
    return startedAt.getTime() > Date.now() - N8N_CLAIM_STALE_MS;
  }
  return true;
}

async function claimWorkflowItem(
  tx: TxClient,
  itemId: string,
  claimedAt: Date,
  staleAfterMs?: number,
): Promise<boolean> {
  const staleBefore = staleAfterMs ? new Date(claimedAt.getTime() - staleAfterMs) : null;
  const claim = await tx.workflowItem.updateMany({
    where: {
      id: itemId,
      doneAt: null,
      ...(staleBefore
        ? { OR: [{ startedAt: null }, { startedAt: { lte: staleBefore } }] }
        : { startedAt: null }),
    },
    data: { startedAt: claimedAt },
  });
  return claim.count === 1;
}

function resolveEmailTemplate(
  template: { subject: string; bodyMd: string } | null,
  fallback: { subject: string; body: string },
): { subject: string; body: string } {
  if (!template) return fallback;
  return { subject: template.subject, body: template.bodyMd };
}

async function buildRecipientSnapshots(
  opts: ClientEmailStepOpts,
): Promise<{ ok: true; snapshots: RecipientSnapshot[] } | { ok: false; error: string }> {
  const { tx, itemId, clientId, itemTitle, config } = opts;
  const emailTemplateId =
    typeof config['emailTemplateId'] === 'string' ? config['emailTemplateId'] : null;
  let subjectTpl = String(config['subject'] ?? itemTitle);
  let bodyTpl = String(config['bodyMd'] ?? '');
  if (emailTemplateId) {
    const template = await tx.emailTemplate.findUnique({ where: { id: emailTemplateId } });
    const resolved = resolveEmailTemplate(template, { subject: subjectTpl, body: bodyTpl });
    subjectTpl = resolved.subject;
    bodyTpl = resolved.body;
  }

  const client = await tx.client.findUnique({
    where: { id: clientId },
    select: { name: true },
  });
  const contacts = await tx.clientContact.findMany({
    where: { clientId, active: true, notificationsEnabled: true, email: { not: '' } },
    orderBy: { id: 'asc' },
    select: { email: true, fullName: true },
  });
  if (contacts.length === 0) {
    return {
      ok: false,
      error: 'Mandant hat keinen aktiven Portal-Kontakt mit E-Mail-Opt-in.',
    };
  }

  const snapshots = contacts.map((contact) => {
    const vars = {
      contact: { fullName: contact.fullName, email: contact.email },
      client: { name: client?.name ?? '' },
      step: { title: itemTitle },
    };
    const bodyText = renderTemplate(bodyTpl, vars);
    return {
      itemId,
      recipientEmail: contact.email,
      recipientName: contact.fullName,
      subject: renderTemplate(subjectTpl, vars),
      bodyText,
      bodyHtml: markdownToInlineHtml(bodyText),
    };
  });
  return { ok: true, snapshots };
}

async function prepareClientEmail(opts: ClientEmailStepOpts): Promise<ClientEmailPreparation> {
  const { tx, itemId } = opts;
  const existingRecipientCount = await tx.workflowEmailRecipient.count({ where: { itemId } });
  let recipientSnapshots: RecipientSnapshot[] = [];

  // Die Empfängerliste und der gerenderte Inhalt werden nur beim ersten
  // Anstoßen eingefroren. Retries verwenden exakt diese dauerhaften
  // Snapshots und überspringen bereits erfolgreich versendete Reihen.
  if (existingRecipientCount === 0) {
    const snapshotResult = await buildRecipientSnapshots(opts);
    if (!snapshotResult.ok) {
      return { result: snapshotResult, mailJobs: [], claimedAt: null };
    }
    recipientSnapshots = snapshotResult.snapshots;
  }

  const claimedAt = new Date();
  if (!(await claimWorkflowItem(tx, itemId, claimedAt, EMAIL_CLAIM_STALE_MS))) {
    return {
      result: { ok: false, error: 'E-Mail-Versand läuft bereits oder wurde abgeschlossen.' },
      mailJobs: [],
      claimedAt: null,
    };
  }

  if (recipientSnapshots.length > 0) {
    await tx.workflowEmailRecipient.createMany({ data: recipientSnapshots, skipDuplicates: true });
  }
  const staleRecipientBefore = new Date(claimedAt.getTime() - EMAIL_CLAIM_STALE_MS);
  await tx.workflowEmailRecipient.updateMany({
    where: {
      itemId,
      sentAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lte: staleRecipientBefore } }],
    },
    data: { claimedAt, attemptCount: { increment: 1 }, lastError: null },
  });
  const pendingRecipients = await tx.workflowEmailRecipient.findMany({
    where: { itemId, sentAt: null, claimedAt },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      recipientEmail: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
    },
  });
  return {
    result: { ok: true },
    mailJobs: pendingRecipients.map((recipient) => ({
      recipientId: recipient.id,
      to: recipient.recipientEmail,
      subject: recipient.subject,
      text: recipient.bodyText,
      html: recipient.bodyHtml,
    })),
    claimedAt,
  };
}

async function prepareN8nDispatch(opts: {
  tx: TxClient;
  tenantId: string;
  staffId: string;
  itemId: string;
  clientId: string;
  kind: string;
  title: string;
  n8nEvent: string | null;
  config: Record<string, unknown>;
  result: ExecuteResult;
}): Promise<N8nDispatchJob | null> {
  const { tx, tenantId, staffId, itemId, clientId, kind, title, n8nEvent, config, result } = opts;
  if (!n8nEvent) return null;

  // M-N6: der beim N8N_TRIGGER validierte `payload` (step-config) wird
  // tatsächlich mitgegeben.
  const customPayload =
    kind === 'N8N_TRIGGER' && config['payload'] && typeof config['payload'] === 'object'
      ? (config['payload'] as Record<string, unknown>)
      : undefined;
  const eventName = `workflow.step.${n8nEvent}` as const;
  const eventPayload = {
    tenantId,
    itemId,
    clientId,
    kind,
    title,
    ...(result.createdRequestId ? { createdRequestId: result.createdRequestId } : {}),
    ...(result.createdSubmissionId ? { createdSubmissionId: result.createdSubmissionId } : {}),
    ...(customPayload ? { custom: customPayload } : {}),
  };
  const existingDispatch = await tx.workflowN8nDispatch.findUnique({
    where: { itemId },
    select: { id: true, actorStaffId: true, event: true, payload: true },
  });
  const dispatch =
    existingDispatch ??
    (await tx.workflowN8nDispatch.create({
      data: {
        itemId,
        tenantId,
        actorStaffId: staffId,
        event: eventName,
        payload: eventPayload as Prisma.InputJsonObject,
      },
      select: { id: true, actorStaffId: true, event: true, payload: true },
    }));
  return {
    dispatchId: dispatch.id,
    actorStaffId: dispatch.actorStaffId,
    event: dispatch.event as N8nEventName,
    payload: dispatch.payload as Record<string, unknown>,
  };
}

async function recordImmediateExecutionEvidence(opts: {
  tx: TxClient;
  tenantId: string;
  staffId: string;
  itemId: string;
  kind: string;
  n8nEvent: string | null;
  result: ExecuteResult;
}): Promise<void> {
  const { tx, tenantId, staffId, itemId, kind, n8nEvent, result } = opts;
  if (kind === 'CLIENT_EMAIL' || kind === 'N8N_TRIGGER') return;

  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'workflow.item.execute',
    resourceType: 'workflow_item',
    resourceId: itemId,
    after: {
      kind,
      markedDone: result.itemMarkedDone ?? false,
      createdRequestId: result.createdRequestId ?? null,
      createdSubmissionId: result.createdSubmissionId ?? null,
      n8nEvent,
    },
  });
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
  if (!shouldRun || !mailClaimedAt) return null;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const settled = await Promise.all(
    mailJobs.map(async (job) => {
      try {
        await sendMail({
          to: job.to,
          subject: job.subject,
          text: job.text,
          html: job.html,
          tenantId,
        });
        const persisted = await withTenantContext(ctx, (tx) =>
          tx.workflowEmailRecipient.updateMany({
            where: {
              id: job.recipientId,
              itemId,
              sentAt: null,
              claimedAt: mailClaimedAt,
            },
            data: { sentAt: new Date(), claimedAt: null, lastError: null },
          }),
        );
        if (persisted.count !== 1) {
          throw new Error('Versandbestätigung konnte nicht eindeutig persistiert werden.');
        }
        return { ok: true as const, to: job.to };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await withTenantContext(ctx, (tx) =>
          tx.workflowEmailRecipient.updateMany({
            where: {
              id: job.recipientId,
              itemId,
              sentAt: null,
              claimedAt: mailClaimedAt,
            },
            data: { claimedAt: null, lastError: message.slice(0, 2000) },
          }),
        ).catch((persistError) => {
          log.error(
            {
              component: 'workflow-execute-step',
              itemId,
              recipientId: job.recipientId,
              err: (persistError as Error).message,
            },
            'CLIENT_EMAIL: Empfängerfehler konnte nicht persistiert werden',
          );
        });
        return { ok: false as const, to: job.to, error: message };
      }
    }),
  );
  const failures = settled.filter((entry) => !entry.ok);

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
        failures: failures.map((entry) => ({ to: entry.to, err: entry.error })),
      },
      'CLIENT_EMAIL: Versand fehlgeschlagen (Item bleibt offen)',
    );
    return {
      ok: false,
      error: `E-Mail-Versand an ${failures.length} von ${mailJobs.length} Empfängern fehlgeschlagen. Der Schritt bleibt offen.`,
    };
  }

  const completed = await withTenantContext(ctx, async (tx) => {
    const pending = await tx.workflowEmailRecipient.count({
      where: { itemId, sentAt: null },
    });
    if (pending > 0) {
      await tx.workflowItem.updateMany({
        where: { id: itemId, doneAt: null, startedAt: mailClaimedAt },
        data: { startedAt: null },
      });
      return false;
    }
    const recipientCount = await tx.workflowEmailRecipient.count({ where: { itemId } });
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
        recipientCount,
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
  let n8nClaimedAt: Date | null = null;
  let executedKind: string | null = null;
  // M-N2: n8n-Events werden INNERHALB der Tx nur eingesammelt und erst NACH
  // dem Commit gefeuert. `emitN8nEvent` schreibt über prismaOwner (eigene
  // Connection) — ein Feuern vor dem Commit würde bei Rollback ein Event für
  // eine nie existierende Anforderung zustellen bzw. der Worker könnte es vor
  // Sichtbarkeit des Commits verarbeiten (gleiches Muster wie mailJobs).
  const n8nEvents: N8nDispatchJob[] = [];

  const result: ExecuteResult = await withTenantContext(ctx, async (tx) => {
    const modules = await readBooleanTenantModules(tx, tenantId);
    if (!modules.workflows) {
      return { ok: false, error: 'Das Workflow-Modul ist für diese Kanzlei deaktiviert.' };
    }
    const item = await tx.workflowItem.findUnique({
      where: { id: itemId },
      include: { instance: { select: { clientId: true, name: true } } },
    });
    if (!item) return { ok: false, error: 'Workflow-Schritt nicht gefunden.' };
    if (item.doneAt) return { ok: false, error: 'Schritt ist bereits erledigt.' };
    if (hasActiveExecutionClaim(item.kind, item.startedAt)) {
      return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
    }
    executedKind = item.kind;

    const clientId = item.instance.clientId;
    const config = (item.config as Record<string, unknown>) ?? {};
    const result: ExecuteResult = { ok: true };

    switch (item.kind) {
      case 'TASK': {
        // doneAt + startedAt in einem CAS-Write: zwei parallele Klicks können
        // nicht beide erfolgreich abschließen/auditieren.
        const taskClaimedAt = new Date();
        const taskDone = await tx.workflowItem.updateMany({
          where: { id: itemId, doneAt: null, startedAt: null },
          data: {
            startedAt: taskClaimedAt,
            doneAt: taskClaimedAt,
            doneByStaff: staffId,
          },
        });
        if (taskDone.count === 0) {
          return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
        }
        result.itemMarkedDone = true;
        break;
      }

      case 'DOCUMENT_UPLOAD':
        // Erledigung läuft über den Upload-Flow — wir markieren das Item
        // hier nur als „angestoßen" (UI öffnet daraufhin den Upload-Dialog).
        if (!(await claimWorkflowItem(tx, itemId, new Date()))) {
          return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
        }
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
        let formTemplateId: string | null = null;
        let formName: string | null = null;

        if (requestTemplateId) {
          const tpl = await tx.requestTemplate.findUnique({ where: { id: requestTemplateId } });
          if (tpl) {
            title = tpl.title;
            description = tpl.description;
            priority = tpl.priority;
            if (tpl.dueAfterDays != null) dueAfterDays = tpl.dueAfterDays;
            if (tpl.formTemplateId) {
              formTemplateId = tpl.formTemplateId;
              formName = title;
            }
          }
        }

        if (formTemplateId && !modules.forms) {
          return { ok: false, error: 'Das Formular-Modul ist für diese Kanzlei deaktiviert.' };
        }

        // Erst nach vollständiger Vorlagenvalidierung atomar beanspruchen;
        // danach liegen Claim und Folgeartefakte in derselben Transaktion.
        if (!(await claimWorkflowItem(tx, itemId, new Date()))) {
          return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
        }

        if (formTemplateId) {
          const sub = await tx.formSubmission.create({
            data: {
              tenantId,
              templateId: formTemplateId,
              clientId,
              name: formName ?? title,
              workflowItemId: itemId,
              createdByStaff: staffId,
            },
          });
          formSubmissionId = sub.id;
          result.createdSubmissionId = sub.id;
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
        if (formSubmissionId) {
          await tx.formSubmission.update({
            where: { id: formSubmissionId },
            data: { requestId: req.id },
          });
        }
        result.createdRequestId = req.id;
        break;
      }

      case 'CLIENT_FORM': {
        if (!modules.forms) {
          return { ok: false, error: 'Das Formular-Modul ist für diese Kanzlei deaktiviert.' };
        }
        const formTemplateId = String(config['formTemplateId'] ?? '');
        if (!formTemplateId) return { ok: false, error: 'Schritt enthält keine Formular-Vorlage.' };
        const tpl = await tx.formTemplate.findUnique({ where: { id: formTemplateId } });
        if (!tpl) return { ok: false, error: 'Formular-Vorlage nicht gefunden.' };
        if (!tpl.active) return { ok: false, error: 'Formular-Vorlage ist deaktiviert.' };

        if (!(await claimWorkflowItem(tx, itemId, new Date()))) {
          return { ok: false, error: 'Schritt wurde bereits angestoßen.' };
        }

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
        await tx.formSubmission.update({
          where: { id: sub.id },
          data: { requestId: req.id },
        });
        result.createdRequestId = req.id;
        result.createdSubmissionId = sub.id;
        break;
      }

      case 'CLIENT_EMAIL': {
        const email = await prepareClientEmail({
          tx,
          itemId,
          clientId,
          itemTitle: item.title,
          config,
        });
        if (!email.result.ok) return email.result;
        mailJobs.push(...email.mailJobs);
        mailClaimedAt = email.claimedAt;
        mailAuditN8nEvent = item.n8nEvent;
        break;
      }

      case 'N8N_TRIGGER': {
        if (!item.n8nEvent) {
          return { ok: false, error: 'n8n-Schritt enthält kein Event.' };
        }
        const claimedAt = new Date();
        if (!(await claimWorkflowItem(tx, itemId, claimedAt, N8N_CLAIM_STALE_MS))) {
          return { ok: false, error: 'n8n-Schritt läuft bereits oder wurde abgeschlossen.' };
        }
        n8nClaimedAt = claimedAt;
        break;
      }
    }

    // n8n-Event einsammeln (für alle Kinds — wenn gesetzt); gefeuert wird nach
    // dem Commit (M-N2). F8: item.n8nEvent ist beim Save via Regex auf
    // [a-z0-9._-]{1,41} begrenzt → `workflow.step.${...}` ist im
    // WorkflowStepN8nEvent-Template-Type, kein unsafe-Cast nötig.
    const n8nDispatch = await prepareN8nDispatch({
      tx,
      tenantId,
      staffId,
      itemId,
      clientId,
      kind: item.kind,
      title: item.title,
      n8nEvent: item.n8nEvent,
      config,
      result,
    });
    if (n8nDispatch) n8nEvents.push(n8nDispatch);

    // CLIENT_EMAIL und N8N_TRIGGER werden erst nach dem bestätigten externen
    // Handoff auditiert/abgeschlossen. Bei WRITE_FAILED bleibt N8N retrybar.
    await recordImmediateExecutionEvidence({
      tx,
      tenantId,
      staffId,
      itemId,
      kind: item.kind,
      n8nEvent: item.n8nEvent,
      result,
    });

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
  let emittedN8n: Awaited<ReturnType<typeof emitN8nEvent>>[] = [];
  if (result.ok) {
    emittedN8n = await Promise.all(
      n8nEvents.map((event) =>
        emitN8nEvent(event.event, event.payload, {
          tenantId,
          dedupeKey: `workflow-dispatch:${event.dispatchId}`,
        }),
      ),
    );
    await Promise.all(
      n8nEvents.map((event, index) => {
        const emitted = emittedN8n[index]!;
        const failed = emitted.status === 'WRITE_FAILED' || emitted.status === 'INVALID_EVENT';
        // Für N8N_TRIGGER bilden Dispatch-Handoff, fachlicher Abschluss und
        // Evidence unten eine einzige Transaktion. So bleibt bei einem Crash
        // entweder alles pending (Worker-Recovery) oder alles abgeschlossen.
        if (!failed && executedKind === 'N8N_TRIGGER') return Promise.resolve();
        return withTenantContext(ctx, (tx) =>
          tx.workflowN8nDispatch.updateMany({
            where: { id: event.dispatchId, tenantId, enqueuedAt: null },
            data: failed
              ? {
                  claimedAt: null,
                  attemptCount: { increment: 1 },
                  lastError: (emitted.error ?? emitted.status).slice(0, 2000),
                }
              : {
                  claimedAt: null,
                  enqueuedAt: new Date(),
                  outboxId: emitted.eventId,
                  attemptCount: { increment: 1 },
                  lastError: null,
                },
          }),
        );
      }),
    );
  }

  if (executedKind === 'N8N_TRIGGER' && n8nClaimedAt) {
    const failedWrite = emittedN8n.find(
      (event) => event.status === 'WRITE_FAILED' || event.status === 'INVALID_EVENT',
    );
    if (failedWrite) {
      await withTenantContext(ctx, (tx) =>
        tx.workflowItem.updateMany({
          where: { id: itemId, doneAt: null, startedAt: n8nClaimedAt },
          data: { startedAt: null },
        }),
      );
      return {
        ok: false,
        error:
          failedWrite.error ??
          'n8n-Outbox konnte nicht geschrieben werden. Der Schritt kann erneut versucht werden.',
      };
    }

    const n8nEvent = n8nEvents[0];
    const emitted = emittedN8n[0];
    if (!n8nEvent || !emitted) {
      return { ok: false, error: 'n8n-Schritt enthält keinen dauerhaften Dispatch.' };
    }

    const completed = await withTenantContext(ctx, async (tx) => {
      // Gleiche Lock-Reihenfolge wie der Worker: erst Dispatch, dann Item.
      // Gewinnt der Worker, sehen wir danach bereits doneAt und behandeln den
      // deduplizierten Abschluss idempotent als Erfolg.
      const dispatchDone = await tx.workflowN8nDispatch.updateMany({
        where: { id: n8nEvent.dispatchId, tenantId, enqueuedAt: null },
        data: {
          claimedAt: null,
          enqueuedAt: new Date(),
          outboxId: emitted.eventId,
          attemptCount: { increment: 1 },
          lastError: null,
        },
      });
      if (dispatchDone.count !== 1) {
        const current = await tx.workflowItem.findUnique({
          where: { id: itemId },
          select: { doneAt: true },
        });
        return Boolean(current?.doneAt);
      }

      const done = await tx.workflowItem.updateMany({
        where: { id: itemId, doneAt: null, startedAt: n8nClaimedAt },
        data: { doneAt: new Date(), doneByStaff: n8nEvent.actorStaffId },
      });
      if (done.count !== 1) {
        const current = await tx.workflowItem.findUnique({
          where: { id: itemId },
          select: { doneAt: true },
        });
        if (current?.doneAt) return true;
        throw new Error('N8N_TRIGGER_FINALIZE_CAS_CONFLICT');
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: n8nEvent.actorStaffId,
        action: 'workflow.item.execute',
        resourceType: 'workflow_item',
        resourceId: itemId,
        after: {
          kind: 'N8N_TRIGGER',
          markedDone: true,
          n8nEvent: n8nEvent.event,
          n8nOutboxId: emitted.eventId,
          n8nStatus: emitted.status,
        },
      });
      return true;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'N8N_TRIGGER_FINALIZE_CAS_CONFLICT') {
        return false;
      }
      throw error;
    });
    if (!completed) {
      return {
        ok: false,
        error: 'n8n-Event wurde persistiert, der Workflow-Schritt aber nicht abgeschlossen.',
      };
    }
    result.itemMarkedDone = true;
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
