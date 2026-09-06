-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- Clusterweiter Monotonie-Anker fuer den signierten FIDO-MDS-BLOB. Die
-- Tabelle enthaelt keine Mandantendaten und bleibt ausschliesslich der
-- Owner-Verbindung vorbehalten; die App-Rolle erhaelt keinerlei Rechte.

BEGIN;

CREATE TABLE public."fido_mds_trust_state" (
  "singleton" BOOLEAN NOT NULL DEFAULT TRUE,
  "blob_serial" BIGINT NOT NULL,
  "next_update" DATE NOT NULL,
  "verified_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fido_mds_trust_state_pkey" PRIMARY KEY ("singleton"),
  CONSTRAINT "fido_mds_trust_state_singleton_check" CHECK ("singleton"),
  CONSTRAINT "fido_mds_trust_state_blob_serial_check" CHECK ("blob_serial" > 0)
);

COMMENT ON TABLE public."fido_mds_trust_state" IS
  'Owner-only Monotonie-Anker fuer die zuletzt verifizierte FIDO-MDS-BLOB-Seriennummer.';

REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM PUBLIC;
REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM taxtronik_app;

COMMIT;
