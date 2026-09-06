// =============================================================================
// Repeat-Scheduler. Namen und Zeitpläne liegen in
// @taxtronik/config/job-queues, damit Worker, Logs und Ops-UI nicht driften.
//
// Idempotent: doppelte Ausführungen pro Tag sind no-ops (notify dedupliziert,
// evidence-seal skippt bereits versiegelte Tage).
// =============================================================================

import {
  mailboxPollQueue,
  sanctionsRefreshQueue,
  evidenceSealQueue,
  auditAnchorQueue,
  gwgExpiryQueue,
  invoiceOverdueQueue,
  auditVerifyQueue,
  taxDeadlineMaterializeQueue,
  auditRotateQueue,
  taxNewsFetchQueue,
  remindersDailyQueue,
  n8nOutboxReconcileQueue,
  n8nRetentionQueue,
  magicLinkCleanupQueue,
  dsgvoRetentionQueue,
  poaExpiryQueue,
  backupDrillQueue,
  backupRunQueue,
  healthAlertQueue,
  workflowN8nDispatchQueue,
  workflowFeedbackQueue,
  storageOrphanCleanupQueue,
  portalInboxCleanupQueue,
} from './queues';
import { JOB_QUEUES, SCHEDULE_LOG_LABELS } from '@taxtronik/config/job-queues';
import { log } from './logger';

// RF-2: Gemeinsame Retry-Policy für periodische Wartungs-Jobs. Ein transienter
// Redis-/DB-/Netz-Fehler um die nächtliche Laufzeit soll den Job nicht bis zum
// nächsten Kalendertag ausfallen lassen (v. a. den Integritäts-Check
// audit-verify-check). Alle diese Jobs sind idempotent. Die 5-Minuten-Jobs
// (health-alert, n8n-outbox-reconcile) brauchen das nicht — der nächste Lauf
// kommt ohnehin gleich.
const DAILY_RETRY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5 * 60_000 },
} as const;

export async function setupSchedules(): Promise<void> {
  await mailboxPollQueue.upsertJobScheduler(
    JOB_QUEUES.mailboxPoll.schedule.schedulerId,
    JOB_QUEUES.mailboxPoll.schedule.repeat,
    { name: JOB_QUEUES.mailboxPoll.name, data: {} },
  );
  await sanctionsRefreshQueue.upsertJobScheduler(
    JOB_QUEUES.sanctionsRefresh.schedule.schedulerId,
    JOB_QUEUES.sanctionsRefresh.schedule.repeat,
    { name: JOB_QUEUES.sanctionsRefresh.name, data: {}, opts: DAILY_RETRY },
  );
  // Rolling dual stamp: frequent reconciliation, but no TSA call in the
  // business transaction. A tick coalesces bursts by timestamping only the
  // latest committed chain tip per tenant.
  await auditAnchorQueue.upsertJobScheduler(
    JOB_QUEUES.auditAnchor.schedule.schedulerId,
    JOB_QUEUES.auditAnchor.schedule.repeat,
    { name: JOB_QUEUES.auditAnchor.name, data: {} },
  );
  await evidenceSealQueue.upsertJobScheduler(
    JOB_QUEUES.evidenceSeal.schedule.schedulerId,
    JOB_QUEUES.evidenceSeal.schedule.repeat,
    {
      name: JOB_QUEUES.evidenceSeal.name,
      data: {},
      // RF-2: Retries für den Versiegelungslauf — ein transienter Fehler
      // (TSA/DB kurz weg) soll nicht bis zum nächsten Kalendertag warten.
      // Verpasste Tage holt der Lauf ohnehin per Backfill nach.
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 } },
    },
  );
  await auditVerifyQueue.upsertJobScheduler(
    JOB_QUEUES.auditVerify.schedule.schedulerId,
    JOB_QUEUES.auditVerify.schedule.repeat,
    { name: JOB_QUEUES.auditVerify.name, data: {}, opts: DAILY_RETRY },
  );
  await gwgExpiryQueue.upsertJobScheduler(
    JOB_QUEUES.gwgExpiry.schedule.schedulerId,
    JOB_QUEUES.gwgExpiry.schedule.repeat,
    { name: JOB_QUEUES.gwgExpiry.name, data: {}, opts: DAILY_RETRY },
  );
  await invoiceOverdueQueue.upsertJobScheduler(
    JOB_QUEUES.invoiceOverdue.schedule.schedulerId,
    JOB_QUEUES.invoiceOverdue.schedule.repeat,
    { name: JOB_QUEUES.invoiceOverdue.name, data: {}, opts: DAILY_RETRY },
  );
  await taxDeadlineMaterializeQueue.upsertJobScheduler(
    JOB_QUEUES.taxDeadlineMaterialize.schedule.schedulerId,
    JOB_QUEUES.taxDeadlineMaterialize.schedule.repeat,
    { name: JOB_QUEUES.taxDeadlineMaterialize.name, data: {}, opts: DAILY_RETRY },
  );
  // Audit-Rotation: wöchentlich Sonntag 03:00 UTC
  await auditRotateQueue.upsertJobScheduler(
    JOB_QUEUES.auditRotate.schedule.schedulerId,
    JOB_QUEUES.auditRotate.schedule.repeat,
    { name: JOB_QUEUES.auditRotate.name, data: {}, opts: DAILY_RETRY },
  );
  // BMF/BFH-RSS-Feeds: alle 2 Stunden zwischen 06:30 und 20:30 Berlin, damit
  // der RSS-Reader tagsüber aktuell bleibt (Insert ist idempotent, neue Items
  // werden nur einmal angelegt). Scheduler-ID bleibt stabil, damit der Upsert
  // den alten Tagesplan ersetzt statt einen zweiten anzulegen.
  await taxNewsFetchQueue.upsertJobScheduler(
    JOB_QUEUES.taxNewsFetch.schedule.schedulerId,
    JOB_QUEUES.taxNewsFetch.schedule.repeat,
    { name: JOB_QUEUES.taxNewsFetch.name, data: {}, opts: DAILY_RETRY },
  );
  // Reminder-Bündel täglich 07:45 Berlin: Einspruchsfristen + Wiedervorlagen +
  // überfällige Pendelordner. Notifications werden idempotent angelegt.
  await remindersDailyQueue.upsertJobScheduler(
    JOB_QUEUES.remindersDaily.schedule.schedulerId,
    JOB_QUEUES.remindersDaily.schedule.repeat,
    { name: JOB_QUEUES.remindersDaily.name, data: {}, opts: DAILY_RETRY },
  );
  // S15 Outbox-Reconciliation: alle 5 Minuten stuck PENDING-Reihen erneut
  // einreihen (App-Crash zwischen Outbox-Write und Queue-Add).
  await n8nOutboxReconcileQueue.upsertJobScheduler(
    JOB_QUEUES.n8nOutboxReconcile.schedule.schedulerId,
    JOB_QUEUES.n8nOutboxReconcile.schedule.repeat,
    { name: JOB_QUEUES.n8nOutboxReconcile.name, data: {} },
  );
  // Fachliche Workflow-Events liegen vor dem Outbox-Handoff dauerhaft in der
  // DB. WRITE_FAILED-/Crash-Fälle werden minütlich mit stabilem Dedupe-Key
  // nachgezogen.
  await workflowN8nDispatchQueue.upsertJobScheduler(
    JOB_QUEUES.workflowN8nDispatch.schedule.schedulerId,
    JOB_QUEUES.workflowN8nDispatch.schedule.repeat,
    { name: JOB_QUEUES.workflowN8nDispatch.name, data: {} },
  );
  await workflowFeedbackQueue.upsertJobScheduler(
    JOB_QUEUES.workflowFeedback.schedule.schedulerId,
    JOB_QUEUES.workflowFeedback.schedule.repeat,
    { name: JOB_QUEUES.workflowFeedback.name, data: {} },
  );
  await storageOrphanCleanupQueue.upsertJobScheduler(
    JOB_QUEUES.storageOrphanCleanup.schedule.schedulerId,
    JOB_QUEUES.storageOrphanCleanup.schedule.repeat,
    { name: JOB_QUEUES.storageOrphanCleanup.name, data: {}, opts: DAILY_RETRY },
  );
  await portalInboxCleanupQueue.upsertJobScheduler(
    JOB_QUEUES.portalInboxCleanup.schedule.schedulerId,
    JOB_QUEUES.portalInboxCleanup.schedule.repeat,
    { name: JOB_QUEUES.portalInboxCleanup.name, data: {}, opts: DAILY_RETRY },
  );
  // Begrenzte n8n-Historie: normale Terminal-Events 90 Tage, Fehler/Partial
  // 180 Tage. Der Worker löscht nur weiterhin terminale Reihen in Batches.
  await n8nRetentionQueue.upsertJobScheduler(
    JOB_QUEUES.n8nRetention.schedule.schedulerId,
    JOB_QUEUES.n8nRetention.schedule.repeat,
    { name: JOB_QUEUES.n8nRetention.name, data: {}, opts: DAILY_RETRY },
  );
  // H6: Magic-Link-Cleanup täglich 03:30 UTC — Tabelle wächst sonst unbegrenzt.
  await magicLinkCleanupQueue.upsertJobScheduler(
    JOB_QUEUES.magicLinkCleanup.schedule.schedulerId,
    JOB_QUEUES.magicLinkCleanup.schedule.repeat,
    { name: JOB_QUEUES.magicLinkCleanup.name, data: {}, opts: DAILY_RETRY },
  );
  // DSGVO-Retention täglich 04:00 UTC — löscht Notifications (>1J), Phone-Notes
  // (>3J) und nullt client_contact.lastLoginAt (>2J). Siehe dsgvo-konzept.md 2.2.
  await dsgvoRetentionQueue.upsertJobScheduler(
    JOB_QUEUES.dsgvoRetention.schedule.schedulerId,
    JOB_QUEUES.dsgvoRetention.schedule.repeat,
    { name: JOB_QUEUES.dsgvoRetention.name, data: {}, opts: DAILY_RETRY },
  );
  // Vollmachten-Ablauf täglich 07:20 Europe/Berlin (nach gwg-expiry/invoice-overdue).
  await poaExpiryQueue.upsertJobScheduler(
    JOB_QUEUES.poaExpiry.schedule.schedulerId,
    JOB_QUEUES.poaExpiry.schedule.repeat,
    { name: JOB_QUEUES.poaExpiry.name, data: {}, opts: DAILY_RETRY },
  );
  // P1-24: automatisches tägliches Backup um 01:00 UTC (nachts, vor allem
  // anderen). Streamt pg_dump → S3. Ohne Zeitplan hatten update-los betriebene
  // Installationen faktisch kein aktuelles Backup; der Staleness-Alarm in
  // health-alert schlägt an, falls dieser Lauf ausfällt.
  await backupRunQueue.upsertJobScheduler(
    JOB_QUEUES.backupRun.schedule.schedulerId,
    JOB_QUEUES.backupRun.schedule.repeat,
    {
      name: JOB_QUEUES.backupRun.name,
      data: {},
      opts: { attempts: 2, backoff: { type: 'exponential', delay: 30 * 60_000 } },
    },
  );
  // Restore-Drill: monatlich am 1. um 05:00 UTC — beweisbarer Wirksamkeits-
  // nachweis der Sicherung (Art. 32 DSGVO / GoBD). Retry, weil transiente
  // S3-/DB-Fehler nicht bis zum nächsten Monat warten sollen.
  await backupDrillQueue.upsertJobScheduler(
    JOB_QUEUES.backupDrill.schedule.schedulerId,
    JOB_QUEUES.backupDrill.schedule.repeat,
    {
      name: JOB_QUEUES.backupDrill.name,
      data: {},
      opts: { attempts: 2, backoff: { type: 'exponential', delay: 30 * 60_000 } },
    },
  );
  // Health-Alert alle 5 Minuten: Down-/Up-Mails an OPS_ALERT_EMAIL bei
  // Infrastruktur-Ausfall (No-Op, solange die Adresse nicht gesetzt ist).
  await healthAlertQueue.upsertJobScheduler(
    JOB_QUEUES.healthAlert.schedule.schedulerId,
    JOB_QUEUES.healthAlert.schedule.repeat,
    { name: JOB_QUEUES.healthAlert.name, data: {} },
  );

  log.info({ schedules: SCHEDULE_LOG_LABELS }, 'scheduler: registered');
}
