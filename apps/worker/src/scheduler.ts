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
} from './queues';
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

// P2-17: büro-zeit-relevante Morgen-Jobs laufen in Europe/Berlin, damit die
// Startzeit nicht mit der Sommer-/Winterzeit um eine Stunde verrutscht (vorher
// reines UTC → im Sommer teils nach Bürobeginn). Die NÄCHTLICHEN Integritäts-
// Jobs (evidence-seal/audit-verify: an UTC-Tagesgrenzen gekoppelt) bleiben
// bewusst in UTC.
const BERLIN = 'Europe/Berlin';

export async function setupSchedules(): Promise<void> {
  // Rolling dual stamp: frequent reconciliation, but no TSA call in the
  // business transaction. A tick coalesces bursts by timestamping only the
  // latest committed chain tip per tenant.
  await auditAnchorQueue.upsertJobScheduler(
    'rolling-audit-anchor',
    { every: 2_000 },
    { name: 'audit-anchor', data: {} },
  );
  await evidenceSealQueue.upsertJobScheduler(
    'daily-seal',
    { pattern: '30 2 * * *' },
    {
      name: 'evidence-seal',
      data: {},
      // RF-2: Retries für den Versiegelungslauf — ein transienter Fehler
      // (TSA/DB kurz weg) soll nicht bis zum nächsten Kalendertag warten.
      // Verpasste Tage holt der Lauf ohnehin per Backfill nach.
      opts: { attempts: 3, backoff: { type: 'exponential', delay: 5 * 60_000 } },
    },
  );
  await auditVerifyQueue.upsertJobScheduler(
    'daily-audit-verify',
    { pattern: '45 2 * * *' },
    { name: 'audit-verify-check', data: {}, opts: DAILY_RETRY },
  );
  await gwgExpiryQueue.upsertJobScheduler(
    'daily-gwg-expiry',
    { pattern: '0 7 * * *', tz: BERLIN },
    { name: 'gwg-expiry-check', data: {}, opts: DAILY_RETRY },
  );
  await invoiceOverdueQueue.upsertJobScheduler(
    'daily-invoice-overdue',
    { pattern: '15 7 * * *', tz: BERLIN },
    { name: 'invoice-overdue-check', data: {}, opts: DAILY_RETRY },
  );
  await taxDeadlineMaterializeQueue.upsertJobScheduler(
    'daily-tax-deadline-materialize',
    { pattern: '30 7 * * *', tz: BERLIN },
    { name: 'tax-deadline-materialize', data: {}, opts: DAILY_RETRY },
  );
  // Audit-Rotation: wöchentlich Sonntag 03:00 UTC
  await auditRotateQueue.upsertJobScheduler(
    'weekly-audit-rotate',
    { pattern: '0 3 * * 0' },
    { name: 'audit-rotate', data: {}, opts: DAILY_RETRY },
  );
  // BMF/BFH-RSS-Feeds: alle 2 Stunden zwischen 06:30 und 20:30 Berlin, damit
  // der RSS-Reader tagsüber aktuell bleibt (Insert ist idempotent, neue Items
  // werden nur einmal angelegt). Scheduler-ID bleibt stabil, damit der Upsert
  // den alten Tagesplan ersetzt statt einen zweiten anzulegen.
  await taxNewsFetchQueue.upsertJobScheduler(
    'daily-tax-news-fetch',
    { pattern: '30 6-20/2 * * *', tz: BERLIN },
    { name: 'tax-news-fetch', data: {}, opts: DAILY_RETRY },
  );
  // Reminder-Bündel täglich 07:45 Berlin: Einspruchsfristen + Wiedervorlagen +
  // überfällige Pendelordner. Notifications werden idempotent angelegt.
  await remindersDailyQueue.upsertJobScheduler(
    'daily-reminders',
    { pattern: '45 7 * * *', tz: BERLIN },
    { name: 'reminders-daily', data: {}, opts: DAILY_RETRY },
  );
  // S15 Outbox-Reconciliation: alle 5 Minuten stuck PENDING-Reihen erneut
  // einreihen (App-Crash zwischen Outbox-Write und Queue-Add).
  await n8nOutboxReconcileQueue.upsertJobScheduler(
    'n8n-outbox-reconcile',
    { every: 5 * 60_000 },
    { name: 'n8n-outbox-reconcile', data: {} },
  );
  // Begrenzte n8n-Historie: normale Terminal-Events 90 Tage, Fehler/Partial
  // 180 Tage. Der Worker löscht nur weiterhin terminale Reihen in Batches.
  await n8nRetentionQueue.upsertJobScheduler(
    'daily-n8n-retention',
    { pattern: '45 3 * * *' },
    { name: 'n8n-retention', data: {}, opts: DAILY_RETRY },
  );
  // H6: Magic-Link-Cleanup täglich 03:30 UTC — Tabelle wächst sonst unbegrenzt.
  await magicLinkCleanupQueue.upsertJobScheduler(
    'daily-magic-link-cleanup',
    { pattern: '30 3 * * *' },
    { name: 'magic-link-cleanup', data: {}, opts: DAILY_RETRY },
  );
  // DSGVO-Retention täglich 04:00 UTC — löscht Notifications (>1J), Phone-Notes
  // (>3J) und nullt client_contact.lastLoginAt (>2J). Siehe dsgvo-konzept.md 2.2.
  await dsgvoRetentionQueue.upsertJobScheduler(
    'daily-dsgvo-retention',
    { pattern: '0 4 * * *' },
    { name: 'dsgvo-retention', data: {}, opts: DAILY_RETRY },
  );
  // Vollmachten-Ablauf täglich 06:20 UTC (nach gwg-expiry/invoice-overdue).
  await poaExpiryQueue.upsertJobScheduler(
    'daily-poa-expiry',
    { pattern: '20 7 * * *', tz: BERLIN },
    { name: 'poa-expiry-check', data: {}, opts: DAILY_RETRY },
  );
  // P1-24: automatisches tägliches Backup um 01:00 UTC (nachts, vor allem
  // anderen). Streamt pg_dump → S3. Ohne Zeitplan hatten update-los betriebene
  // Installationen faktisch kein aktuelles Backup; der Staleness-Alarm in
  // health-alert schlägt an, falls dieser Lauf ausfällt.
  await backupRunQueue.upsertJobScheduler(
    'daily-backup-run',
    { pattern: '0 1 * * *' },
    {
      name: 'backup-run',
      data: {},
      opts: { attempts: 2, backoff: { type: 'exponential', delay: 30 * 60_000 } },
    },
  );
  // Restore-Drill: monatlich am 1. um 05:00 UTC — beweisbarer Wirksamkeits-
  // nachweis der Sicherung (Art. 32 DSGVO / GoBD). Retry, weil transiente
  // S3-/DB-Fehler nicht bis zum nächsten Monat warten sollen.
  await backupDrillQueue.upsertJobScheduler(
    'monthly-backup-drill',
    { pattern: '0 5 1 * *' },
    {
      name: 'backup-drill',
      data: {},
      opts: { attempts: 2, backoff: { type: 'exponential', delay: 30 * 60_000 } },
    },
  );
  // Health-Alert alle 5 Minuten: Down-/Up-Mails an OPS_ALERT_EMAIL bei
  // Infrastruktur-Ausfall (No-Op, solange die Adresse nicht gesetzt ist).
  await healthAlertQueue.upsertJobScheduler(
    'health-alert',
    { every: 5 * 60_000 },
    { name: 'health-alert', data: {} },
  );

  log.info(
    {
      schedules: [
        'audit-anchor @ every 2 sec',
        'evidence-seal @ 02:30 UTC daily',
        'audit-verify-check @ 02:45 UTC daily',
        'audit-rotate @ 03:00 UTC sundays',
        'gwg-expiry-check @ 07:00 Berlin daily',
        'invoice-overdue-check @ 07:15 Berlin daily',
        'tax-deadline-materialize @ 07:30 Berlin daily',
        'tax-news-fetch @ 06:30 Berlin daily',
        'reminders-daily @ 07:45 Berlin daily',
        'n8n-outbox-reconcile @ every 5 min',
        'n8n-retention @ 03:45 UTC daily',
        'magic-link-cleanup @ 03:30 UTC daily',
        'dsgvo-retention @ 04:00 UTC daily',
        'poa-expiry-check @ 07:20 Berlin daily',
        'backup-run @ 01:00 UTC daily',
        'backup-drill @ 05:00 UTC 1st of month',
        'health-alert @ every 5 min',
      ],
    },
    'scheduler: registered',
  );
}
