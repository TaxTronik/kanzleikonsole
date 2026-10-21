-- TCMS-NACHWEIS-001 / GWG-RETENTION-DESTRUCTION-001, ACCESS-TENANT-RLS-001
-- (notification_daily_dedupe und notification_daily_dedupe_nullstaff zuletzt
-- aus 20261007141100_notification_daily_dedupe_maintenance_backlog)
--
-- RT3D-K-01 (kk-tcms-fix5): Das Aufbewahrungsende eines GwG-Belegs mit Verweis
-- des Tax-CMS steigt auf die Steuerfrist bzw. das Ende der GwG-Frist; der
-- GOVERNANCE-Lock seiner Objektversionen im GwG-Bucket blieb bei 5 Jahren und
-- 1 Tag ab Upload. Der Worker-Job gwg-object-lock-extend verlängert ihn nach
-- dem Commit bis zum Aufbewahrungsende (nur verlängern, nie verkürzen) und
-- führt den Stand je Objektversion in dieser Tabelle:
--   - retain_until: zuletzt nachgelesenes Lock-Ende (NULL: nie bestätigt);
--     offen ist eine Version, solange es vor dem Aufbewahrungsende liegt;
--   - failed_since/failed_attempts/last_error: Fehlschläge seit dem letzten
--     Erfolg, Fehler nur als fester Code (keine Bucket-, Schlüssel- oder
--     Antworttexte).
-- Owner-only wie die Zustelltabellen des Tax-CMS: Die App-Rolle erhält keine
-- Rechte (Restore-Invariante in packages/db/src/restore-security.ts). Mit der
-- Objektversion (Vernichtung) bzw. dem Tenant entfällt die Zeile.
--
-- Der Rückstandsalarm (B14) dieses Jobs wird wie die übrigen
-- Wartungsrückstände je Empfänger und UTC-Tag höchstens einmal neu angelegt:
-- Beide Partial-Unique-Indizes werden mit der erweiterten Kind-Liste neu
-- angelegt; Spalten, Tag-Bucket und übrige Prädikate bleiben unverändert.
--
-- Kanonische Quelle (docs/development/kanonische-sql-quellen.md), Tabelle,
-- Index, CHECKs, Grants und Indizes ergänzt:
--   neu:      policies/gwg_object_lock_extension.gwg_object_lock_extension_isolation.sql
BEGIN;

CREATE TABLE public."gwg_object_lock_extension" (
  "document_version_id" UUID           NOT NULL,
  "tenant_id"           UUID           NOT NULL,
  "retain_until"        TIMESTAMP(3),
  "checked_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failed_since"        TIMESTAMPTZ(6),
  "failed_attempts"     INTEGER        NOT NULL DEFAULT 0,
  "last_error"          TEXT,

  CONSTRAINT "gwg_object_lock_extension_pkey" PRIMARY KEY ("document_version_id"),
  CONSTRAINT "gwg_object_lock_extension_document_version_id_fkey"
    FOREIGN KEY ("document_version_id") REFERENCES public."document_version"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "gwg_object_lock_extension_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES public."tenant"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  -- Fehlschläge seit dem letzten Erfolg: alle drei Angaben oder keine.
  CONSTRAINT "gwg_object_lock_extension_fehler_check" CHECK (
    "failed_attempts" >= 0
    AND ("failed_attempts" = 0) = ("failed_since" IS NULL)
    AND ("failed_since" IS NULL) = ("last_error" IS NULL)
  ),
  -- Nur feste Codes (z. B. AccessDenied, OBJECT_LOCK_EXTEND_UNVERIFIED).
  CONSTRAINT "gwg_object_lock_extension_last_error_check"
    CHECK ("last_error" IS NULL OR "last_error" ~ '^[A-Za-z0-9_]{1,64}$')
);
CREATE INDEX "gwg_object_lock_extension_tenant_id_idx"
  ON public."gwg_object_lock_extension"("tenant_id");

COMMENT ON TABLE public."gwg_object_lock_extension" IS
  'Owner-only: verlängerter Object-Lock je Objektversion eines GwG-Belegs mit Verweis des Tax-CMS (RT3D-K-01).';

ALTER TABLE public."gwg_object_lock_extension" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."gwg_object_lock_extension" FORCE ROW LEVEL SECURITY;

CREATE POLICY gwg_object_lock_extension_isolation ON public.gwg_object_lock_extension
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING ((tenant_id = app.current_tenant_id()))
  WITH CHECK ((tenant_id = app.current_tenant_id()));

-- Die Default-Privilegien des Schemas gewähren neuen Tabellen Rechte an die
-- App-Rolle; hier vollständig zurücknehmen (nur der Worker/Owner).
REVOKE ALL ON TABLE public."gwg_object_lock_extension" FROM PUBLIC;
REVOKE ALL ON TABLE public."gwg_object_lock_extension" FROM taxtronik_app;

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
    'SYSTEM_STORAGE_CLEANUP_BACKLOG',
    'SYSTEM_GWG_OBJECT_LOCK_BACKLOG'
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
    'SYSTEM_STORAGE_CLEANUP_BACKLOG',
    'SYSTEM_GWG_OBJECT_LOCK_BACKLOG'
  )
    AND resource_id IS NOT NULL
    AND staff_id IS NULL;

COMMIT;
