-- Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001
-- (notification_daily_dedupe und notification_daily_dedupe_nullstaff aus
-- 20260801000600_iter81)
--
-- Review-Befund P-17 / Entscheidung B14: Der Rückstandsalarm der Wartungsjobs
-- (SYSTEM_AUDIT_ARCHIVE_BACKLOG, SYSTEM_STORAGE_CLEANUP_BACKLOG) wird wie
-- GWG_DELETION_DUE je Empfänger und UTC-Tag höchstens einmal neu angelegt; eine
-- ungelesene Benachrichtigung aktualisiert der Worker. Beide Partial-Unique-
-- Indizes werden mit der erweiterten Kind-Liste neu angelegt; Spalten, Tag-
-- Bucket und übrige Prädikate bleiben unverändert (Definition wie iter81).
BEGIN;

DROP INDEX IF EXISTS notification_daily_dedupe;
DROP INDEX IF EXISTS notification_daily_dedupe_nullstaff;

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
    'POA_EXPIRED',
    'SYSTEM_AUDIT_ARCHIVE_BACKLOG',
    'SYSTEM_STORAGE_CLEANUP_BACKLOG'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NOT NULL;

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
    'POA_EXPIRED',
    'SYSTEM_AUDIT_ARCHIVE_BACKLOG',
    'SYSTEM_STORAGE_CLEANUP_BACKLOG'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NULL;

COMMIT;
