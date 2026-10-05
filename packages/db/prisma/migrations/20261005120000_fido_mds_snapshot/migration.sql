-- Fachkatalog: ACCESS-TENANT-RLS-001
--
-- P-23: Signaturgeprüfter FIDO-MDS-Snapshot im bestehenden owner-only Anker.
-- Der Worker-Job fido-mds-refresh lädt den BLOB, prüft Signer-Identität,
-- JWT-Signatur, Zertifikatskette, CRLs, Seriennummer und nextUpdate, verankert
-- die Serie monoton und legt die geprüften Einträge samt SHA-256 des BLOBs in
-- denselben Datensatz. Hardware-Anmeldung, -Registrierung und
-- Modus-Assertions lesen nur diesen Stand und kontaktieren den FIDO Metadata
-- Service nicht mehr selbst. Ein Snapshot gilt nur, solange snapshot_serial
-- der verankerten blob_serial entspricht.
-- Der Anker bleibt die einzige globale FIDO-Tabelle: keine Mandanten- oder
-- Personendaten, keine Rechte der App-Rolle, keine neue RLS-Ausnahme.

BEGIN;

ALTER TABLE public."fido_mds_trust_state"
  ADD COLUMN "snapshot_serial" BIGINT,
  ADD COLUMN "snapshot_sha256" VARCHAR(64),
  ADD COLUMN "snapshot_entries" JSONB,
  ADD CONSTRAINT "fido_mds_trust_state_snapshot_check" CHECK (
    (
      "snapshot_serial" IS NULL
      AND "snapshot_sha256" IS NULL
      AND "snapshot_entries" IS NULL
    )
    OR (
      "snapshot_serial" IS NOT NULL
      AND "snapshot_sha256" IS NOT NULL
      AND "snapshot_entries" IS NOT NULL
      AND "snapshot_serial" > 0
      AND "snapshot_serial" <= "blob_serial"
      AND "snapshot_sha256" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("snapshot_entries") = 'array'
    )
  );

COMMENT ON COLUMN public."fido_mds_trust_state"."snapshot_entries" IS
  'Signaturgeprüfte FIDO2-Einträge (öffentliche FIDO-Metadaten) des BLOBs snapshot_serial; gültig nur bei snapshot_serial = blob_serial.';

REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM PUBLIC;
REVOKE ALL ON TABLE public."fido_mds_trust_state" FROM taxtronik_app;

COMMIT;
