-- =============================================================================
-- iter81 — GwG § 8 Abs. 4 S. 4: Vernichtung der GwG-AUFZEICHNUNGEN (DB) +
-- aktive Lösch-Queue (GWG_DELETION_DUE).
--
-- Teil 1: gwg_check.destroyed_at — Vernichtungsvermerk. Die bisherige
--   Vernichtung (gwg.evidence.destroy) löschte nur die DATEI-Belege; die
--   DB-Aufzeichnungen (gwg_check.riskAnswers/Breakdown/Notes, wirtschaftlich
--   Berechtigte, Ausweisdetails) blieben unbegrenzt — § 8 Abs. 4 S. 4 GwG
--   verlangt aber die Vernichtung der AUFZEICHNUNGEN. Die neue Aktion
--   (confirmGwgCheckDeletionAction) löscht Berechtigte, nullt Ausweis-Details
--   und riskAnswers/notes und behält einen Skelett-Datensatz mit Status als
--   Nachweis, DASS geprüft wurde. destroyed_at IS NOT NULL = vernichtet.
--
-- Teil 2: NotificationKind GWG_DELETION_DUE — tägliche idempotente
--   Notification an ADMIN/PARTNER, sobald die Lösch-Queue fällige Einträge
--   hat (gwg-expiry-check-Worker; die Queue war vorher rein passiv). Beide
--   Partial-Unique-Dedupe-Indizes (zuletzt iter79) werden per DROP + CREATE
--   mit erweiterter Kind-Liste neu angelegt.
--
--   Postgres-Subtilität: ein per ALTER TYPE … ADD VALUE ergänzter Enum-Wert
--   darf nicht in DERSELBEN Transaktion benutzt werden (die Index-Prädikate
--   unten brauchen ihn aber) — Prisma führt jede Migration in einer
--   Transaktion aus. Deshalb der vollständige Typ-Swap (CREATE TYPE neu →
--   Spalte umhängen → alten Typ droppen): für einen IN dieser Transaktion
--   erzeugten Typ gilt die Beschränkung nicht. Wertereihenfolge = kanonische
--   Reihenfolge aus schema.prisma.
-- =============================================================================

-- ----- Teil 1: Vernichtungsvermerk (GwG § 8 Abs. 4 S. 4) --------------------

ALTER TABLE "gwg_check" ADD COLUMN "destroyed_at" TIMESTAMP(3);

-- ----- Teil 2: GWG_DELETION_DUE + Dedupe-Indizes -----------------------------

-- 2a. Dedupe-Indizes droppen (referenzieren die kind-Spalte → vor Typ-Swap).
DROP INDEX IF EXISTS notification_daily_dedupe;
DROP INDEX IF EXISTS notification_daily_dedupe_nullstaff;

-- 2b. Enum-Typ-Swap mit neuem Wert GWG_DELETION_DUE.
CREATE TYPE "notification_kind_new" AS ENUM (
  'REQUEST_RESPONDED',
  'POA_SIGNED',
  'POA_EXPIRY_SOON',
  'POA_EXPIRED',
  'GWG_EXPIRY_SOON',
  'GWG_EXPIRY_90D',
  'GWG_EXPIRY_30D',
  'GWG_EXPIRED',
  'GWG_ID_EXPIRY_SOON',
  'GWG_ID_EXPIRED',
  'GWG_DELETION_DUE',
  'INVOICE_OVERDUE',
  'PHONE_NOTE_FORWARDED',
  'VACATION_DECISION',
  'SYSTEM_BACKUP_FAILED',
  'SYSTEM_AUDIT_BREAK',
  'SYSTEM_MAIL_FAILED',
  'CLIENT_MASTER_CHANGE_REQUEST',
  'TAX_NEWS_NEW',
  'TAX_NOTICE_APPEAL_REMINDER',
  'CLIENT_REMINDER_DUE',
  'PENDING_BINDER_OVERDUE',
  'APPOINTMENT_REQUESTED',
  'APPOINTMENT_DECIDED'
);

ALTER TABLE "notification"
  ALTER COLUMN "kind" TYPE "notification_kind_new"
  USING ("kind"::text::"notification_kind_new");

DROP TYPE "notification_kind";
ALTER TYPE "notification_kind_new" RENAME TO "notification_kind";

-- 2c. Dedupe-Indizes mit erweiterter Kind-Liste neu anlegen (Technik iter49/79:
--     IMMUTABLE-Tag-Bucket via floor(extract(epoch …)/86400)).
CREATE UNIQUE INDEX notification_daily_dedupe
  ON notification (
    tenant_id,
    staff_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN (
    'TAX_NOTICE_APPEAL_REMINDER',
    'CLIENT_REMINDER_DUE',
    'PENDING_BINDER_OVERDUE',
    'INVOICE_OVERDUE',
    'GWG_EXPIRY_90D',
    'GWG_EXPIRY_30D',
    'GWG_EXPIRED',
    'GWG_ID_EXPIRY_SOON',
    'GWG_ID_EXPIRED',
    'GWG_DELETION_DUE',
    'POA_EXPIRY_SOON',
    'POA_EXPIRED'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NOT NULL;

-- Globale (staff_id = NULL) System-Notifications: eigener Index, weil NULL im
-- Index oben jede Zeile unique macht und der Dedupe damit nie greift (iter79).
CREATE UNIQUE INDEX notification_daily_dedupe_nullstaff
  ON notification (
    tenant_id,
    kind,
    resource_id,
    (floor(extract(epoch from created_at) / 86400))
  )
  WHERE kind IN (
    'TAX_NOTICE_APPEAL_REMINDER',
    'CLIENT_REMINDER_DUE',
    'PENDING_BINDER_OVERDUE',
    'INVOICE_OVERDUE',
    'GWG_EXPIRY_90D',
    'GWG_EXPIRY_30D',
    'GWG_EXPIRED',
    'GWG_ID_EXPIRY_SOON',
    'GWG_ID_EXPIRED',
    'GWG_DELETION_DUE',
    'POA_EXPIRY_SOON',
    'POA_EXPIRED'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NULL;
