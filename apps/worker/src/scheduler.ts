// =============================================================================
// Repeat-Scheduler
//
// Tägliche Wartung (alle UTC):
//   - 02:30 evidence-seal (Vortag versiegeln)
//   - 02:45 audit-verify-check (Hash-Chain prüfen)
//   - 06:00 gwg-expiry-check (in <30 Tagen ablaufende GwG warnen)
//   - 06:15 invoice-overdue-check (überfällige Rechnungen markieren)
//
// Idempotent: doppelte Ausführungen pro Tag sind no-ops (notify dedupliziert,
// evidence-seal skippt bereits versiegelte Tage).
// =============================================================================

import {
  evidenceSealQueue,
  gwgExpiryQueue,
  invoiceOverdueQueue,
  auditVerifyQueue,
  taxDeadlineMaterializeQueue,
  auditRotateQueue,
  taxNewsFetchQueue,
  remindersDailyQueue,
  n8nOutboxReconcileQueue,
  magicLinkCleanupQueue,
  dsgvoRetentionQueue,
} from './queues';
import { log } from './logger';

export async function setupSchedules(): Promise<void> {
  await evidenceSealQueue.upsertJobScheduler(
    'daily-seal',
    { pattern: '30 2 * * *' },
    { name: 'evidence-seal', data: {} },
  );
  await auditVerifyQueue.upsertJobScheduler(
    'daily-audit-verify',
    { pattern: '45 2 * * *' },
    { name: 'audit-verify-check', data: {} },
  );
  await gwgExpiryQueue.upsertJobScheduler(
    'daily-gwg-expiry',
    { pattern: '0 6 * * *' },
    { name: 'gwg-expiry-check', data: {} },
  );
  await invoiceOverdueQueue.upsertJobScheduler(
    'daily-invoice-overdue',
    { pattern: '15 6 * * *' },
    { name: 'invoice-overdue-check', data: {} },
  );
  await taxDeadlineMaterializeQueue.upsertJobScheduler(
    'daily-tax-deadline-materialize',
    { pattern: '30 6 * * *' },
    { name: 'tax-deadline-materialize', data: {} },
  );
  // Audit-Rotation: wöchentlich Sonntag 03:00 UTC
  await auditRotateQueue.upsertJobScheduler(
    'weekly-audit-rotate',
    { pattern: '0 3 * * 0' },
    { name: 'audit-rotate', data: {} },
  );
  // BMF/BFH-RSS-Feeds täglich 05:30 UTC (~07:30 MESZ — vor Bürobeginn)
  await taxNewsFetchQueue.upsertJobScheduler(
    'daily-tax-news-fetch',
    { pattern: '30 5 * * *' },
    { name: 'tax-news-fetch', data: {} },
  );
  // Reminder-Bündel täglich 06:45 UTC: Einspruchsfristen + Wiedervorlagen +
  // überfällige Pendelordner. Notifications werden idempotent angelegt.
  await remindersDailyQueue.upsertJobScheduler(
    'daily-reminders',
    { pattern: '45 6 * * *' },
    { name: 'reminders-daily', data: {} },
  );
  // S15 Outbox-Reconciliation: alle 5 Minuten stuck PENDING-Reihen erneut
  // einreihen (App-Crash zwischen Outbox-Write und Queue-Add).
  await n8nOutboxReconcileQueue.upsertJobScheduler(
    'n8n-outbox-reconcile',
    { every: 5 * 60_000 },
    { name: 'n8n-outbox-reconcile', data: {} },
  );
  // H6: Magic-Link-Cleanup täglich 03:30 UTC — Tabelle wächst sonst unbegrenzt.
  await magicLinkCleanupQueue.upsertJobScheduler(
    'daily-magic-link-cleanup',
    { pattern: '30 3 * * *' },
    { name: 'magic-link-cleanup', data: {} },
  );
  // DSGVO-Retention täglich 04:00 UTC — löscht Notifications (>1J), Phone-Notes
  // (>3J) und nullt client_contact.lastLoginAt (>2J). Siehe dsgvo-konzept.md 2.2.
  await dsgvoRetentionQueue.upsertJobScheduler(
    'daily-dsgvo-retention',
    { pattern: '0 4 * * *' },
    { name: 'dsgvo-retention', data: {} },
  );

  log.info(
    {
      schedules: [
        'evidence-seal @ 02:30 UTC daily',
        'audit-verify-check @ 02:45 UTC daily',
        'audit-rotate @ 03:00 UTC sundays',
        'gwg-expiry-check @ 06:00 UTC daily',
        'invoice-overdue-check @ 06:15 UTC daily',
        'tax-deadline-materialize @ 06:30 UTC daily',
        'tax-news-fetch @ 05:30 UTC daily',
        'reminders-daily @ 06:45 UTC daily',
        'n8n-outbox-reconcile @ every 5 min',
        'magic-link-cleanup @ 03:30 UTC daily',
        'dsgvo-retention @ 04:00 UTC daily',
      ],
    },
    'scheduler: registered',
  );
}
