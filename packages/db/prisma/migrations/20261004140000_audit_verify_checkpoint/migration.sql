-- AUDIT-VERIFY-ALERT-001 / AUDIT-HASH-CHAIN-001 / AUDIT-RFC3161-ANCHOR-001 /
-- ACCESS-TENANT-RLS-001.
--
-- Prüf-Checkpoints der täglichen Audit-Kettenprüfung (Review P-04). Der Worker
-- rechnet nicht mehr jeden Tag die vollständige Kette ab Genesis in einer
-- 120-s-Transaktion nach, sondern setzt die Prüfung ab dem zuletzt geprüften
-- Kettenstand fort. Je Kanzlei-Tenant gibt es höchstens drei Zeilen:
--   INCREMENTAL  zuletzt geprüfter Stand der täglichen Zuwachsprüfung
--   FULL         Fortschritt einer laufenden, fortsetzbaren Vollprüfung
--   FULL_TARGET  bei Start der Vollprüfung eingefrorener INCREMENTAL-Stand,
--                den die Vollprüfung am Ende bestätigen muss
-- Jede Zeile beschreibt eine Kettenposition: Audit-ID und rekonstruierter Hash,
-- verarbeitete Siegel und Rolling-Anker (ID, anchor_hash, top_audit_id) sowie
-- die Zähler ab Genesis.
--
-- `findings` hält die bis zur Position gefundenen Siegel- und Ankerbefunde,
-- damit jeder Lauf sie wie verifyChain erneut meldet. `sweep_id` bindet FULL
-- und FULL_TARGET an ihre Vollprüfung; in der INCREMENTAL-Zeile steht die
-- Kennung der laufenden Vollprüfung (NULL = keine), damit ein fehlender oder
-- fremder Vollprüfungsstand als Eingriff auffällt.
--
-- Die Zeilen sind abgeleiteter Prüfzustand, kein Beweismittel: audit_log,
-- audit_seal und audit_anchor bleiben unverändert. Schreiben darf nur der
-- Owner (Worker). Die App-Rolle erhält ausschließlich tenantgebundenes SELECT,
-- damit ein kompromittierter Request-Pfad keinen Checkpoint vorschieben kann.
-- Jede Zeile trägt zusätzlich eine HMAC-SHA256-Prüfsumme (`mac`) über alle
-- Felder mit einem per HKDF aus dem Worker-Geheimnis abgeleiteten Schlüssel:
-- Ein Owner ohne dieses Geheimnis kann keinen gültigen Checkpoint schreiben.
BEGIN;

CREATE TABLE public."audit_verify_checkpoint" (
  "tenant_id"              UUID           NOT NULL,
  "kind"                   TEXT           NOT NULL,
  "audit_id"               BIGINT         NOT NULL,
  "audit_hash"             BYTEA          NOT NULL,
  "audit_count"            BIGINT         NOT NULL,
  "seal_id"                BIGINT         NOT NULL,
  "seals_checked"          BIGINT         NOT NULL,
  "seals_trust_anchored"   BIGINT,
  "anchor_id"              BIGINT         NOT NULL,
  "anchor_hash"            BYTEA          NOT NULL,
  "anchor_top_audit_id"    BIGINT         NOT NULL,
  "anchors_checked"        BIGINT         NOT NULL,
  "anchors_trust_anchored" BIGINT         NOT NULL,
  "started_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"           TIMESTAMPTZ(6),
  "findings"               JSONB          NOT NULL,
  "sweep_id"               UUID,
  "mac"                    BYTEA          NOT NULL,

  CONSTRAINT "audit_verify_checkpoint_pkey" PRIMARY KEY ("tenant_id", "kind"),
  CONSTRAINT "audit_verify_checkpoint_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_verify_checkpoint_kind_check"
    CHECK ("kind" IN ('INCREMENTAL', 'FULL', 'FULL_TARGET')),
  CONSTRAINT "audit_verify_checkpoint_position_check" CHECK (
    "audit_id" >= 0
    AND "audit_count" >= 0
    AND "seal_id" >= 0
    AND "seals_checked" >= 0
    AND ("seals_trust_anchored" IS NULL
      OR "seals_trust_anchored" BETWEEN 0 AND "seals_checked")
    AND "anchor_id" >= 0
    AND "anchor_top_audit_id" >= 0
    AND "anchors_checked" >= 0
    AND "anchors_trust_anchored" BETWEEN 0 AND "anchors_checked"
  ),
  CONSTRAINT "audit_verify_checkpoint_hash_length_check" CHECK (
    octet_length("audit_hash") = 32 AND octet_length("anchor_hash") = 32
  ),
  CONSTRAINT "audit_verify_checkpoint_findings_check"
    CHECK (jsonb_typeof("findings") = 'object'),
  CONSTRAINT "audit_verify_checkpoint_sweep_check"
    CHECK ("kind" = 'INCREMENTAL' OR "sweep_id" IS NOT NULL),
  CONSTRAINT "audit_verify_checkpoint_mac_length_check" CHECK (octet_length("mac") = 32)
);

COMMENT ON TABLE public."audit_verify_checkpoint" IS
  'Owner-only Prüf-Checkpoints der Audit-Kettenprüfung (abgeleiteter Zustand, kein Beweismittel).';

ALTER TABLE public."audit_verify_checkpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."audit_verify_checkpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_verify_checkpoint_isolation ON public."audit_verify_checkpoint"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

-- Die Default-Privilegien des Schemas gewähren neuen Tabellen SELECT, INSERT,
-- UPDATE und DELETE an die App-Rolle; hier bewusst zurücknehmen.
REVOKE ALL ON TABLE public."audit_verify_checkpoint" FROM PUBLIC;
REVOKE ALL ON TABLE public."audit_verify_checkpoint" FROM taxtronik_app;
GRANT SELECT ON TABLE public."audit_verify_checkpoint" TO taxtronik_app;

COMMIT;
