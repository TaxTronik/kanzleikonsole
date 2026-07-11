-- =============================================================================
-- DSGVO-Anträge: tatsächlicher Eingang, Ergebnis- und Versandnachweis.
-- =============================================================================

ALTER TABLE "dsgvo_request"
  ADD COLUMN "received_at" DATE,
  ADD COLUMN "result_sha256" BYTEA,
  ADD COLUMN "result_prepared_at" TIMESTAMP(3),
  ADD COLUMN "result_prepared_by" UUID,
  ADD COLUMN "result_reviewed_at" TIMESTAMP(3),
  ADD COLUMN "result_reviewed_by" UUID,
  ADD COLUMN "response_sent_at" DATE,
  ADD COLUMN "response_method" TEXT,
  ADD COLUMN "rejection_reason" TEXT;

-- Historischer Bestand kannte nur created_at; dessen Kalendertag ist der
-- belastbarste verfügbare konservative Backfill. Neue Einträge müssen den
-- tatsächlichen Eingang explizit liefern.
UPDATE "dsgvo_request"
SET "received_at" = "created_at"::date
WHERE "received_at" IS NULL;

ALTER TABLE "dsgvo_request"
  ALTER COLUMN "received_at" SET NOT NULL;

-- Ein Abschluss braucht einen dokumentierten Antwortversand. Auskunft und
-- Portabilität brauchen zusätzlich ein gehashtes oder referenziertes Ergebnis.
-- NOT VALID wahrt Altbestand; neue/aktualisierte Datensätze werden sofort
-- geprüft.
ALTER TABLE "dsgvo_request"
  ADD CONSTRAINT "dsgvo_request_completed_evidence_check"
  CHECK (
    "status" <> 'COMPLETED'::"dsgvo_request_status"
    OR (
      "response_sent_at" IS NOT NULL
      AND NULLIF(BTRIM("response_method"), '') IS NOT NULL
      AND (
        "type" NOT IN (
          'ACCESS'::"dsgvo_request_type",
          'PORTABILITY'::"dsgvo_request_type"
        )
        OR (
          ("result_sha256" IS NOT NULL OR "result_document_id" IS NOT NULL)
          AND "result_reviewed_at" IS NOT NULL
          AND "response_sent_at" >= "result_reviewed_at"::date
        )
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT "dsgvo_request_rejected_reason_check"
  CHECK (
    "status" <> 'REJECTED'::"dsgvo_request_status"
    OR (
      "rejection_reason" IS NOT NULL
      AND LENGTH(BTRIM("rejection_reason")) >= 10
      AND "response_sent_at" IS NOT NULL
      AND "response_method" IS NOT NULL
      AND LENGTH(BTRIM("response_method")) >= 2
    )
  ) NOT VALID,
  ADD CONSTRAINT "dsgvo_request_response_sequence_check"
  CHECK ("response_sent_at" IS NULL OR "response_sent_at" >= "received_at")
  NOT VALID,
  ADD CONSTRAINT "dsgvo_request_result_hash_check"
  CHECK ("result_sha256" IS NULL OR OCTET_LENGTH("result_sha256") = 32)
  NOT VALID,
  ADD CONSTRAINT "dsgvo_request_result_evidence_pairs_check"
  CHECK (
    (("result_prepared_at" IS NULL) = ("result_prepared_by" IS NULL))
    AND (("result_reviewed_at" IS NULL) = ("result_reviewed_by" IS NULL))
    AND ("result_sha256" IS NULL OR "result_prepared_at" IS NOT NULL)
    AND (
      "result_reviewed_at" IS NULL
      OR "result_sha256" IS NOT NULL
      OR "result_document_id" IS NOT NULL
    )
    AND (
      "result_prepared_at" IS NULL
      OR "result_reviewed_at" IS NULL
      OR "result_reviewed_at" >= "result_prepared_at"
    )
  )
  NOT VALID;

-- Abschlussnachweise sind Beweisstände, keine nachträglich editierbaren
-- Arbeitsdatensätze. Korrekturen erfolgen als neuer Vorgang/Audit-Eintrag.
CREATE OR REPLACE FUNCTION app.protect_dsgvo_terminal_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW."result_document_id" IS DISTINCT FROM OLD."result_document_id"
       OR NEW."result_sha256" IS DISTINCT FROM OLD."result_sha256"
     )
     AND NEW."result_reviewed_at" IS NOT DISTINCT FROM OLD."result_reviewed_at"
     AND NEW."result_reviewed_by" IS NOT DISTINCT FROM OLD."result_reviewed_by" THEN
    NEW."result_reviewed_at" := NULL;
    NEW."result_reviewed_by" := NULL;
  END IF;

  IF NEW."result_document_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "document" d
       WHERE d."id" = NEW."result_document_id"
         AND d."tenant_id" = NEW."tenant_id"
         AND d."deleted_at" IS NULL
     ) THEN
    RAISE EXCEPTION 'DSGVO-Ergebnisdokument fehlt oder gehört zu einem anderen Tenant.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('COMPLETED', 'REJECTED') THEN
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."created_by_staff" IS DISTINCT FROM OLD."created_by_staff"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
       OR NEW."subject_ref_id" IS DISTINCT FROM OLD."subject_ref_id"
       OR NEW."subject_email" IS DISTINCT FROM OLD."subject_email"
       OR NEW."subject_name" IS DISTINCT FROM OLD."subject_name"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
       OR NEW."due_date" IS DISTINCT FROM OLD."due_date"
       OR NEW."notes" IS DISTINCT FROM OLD."notes"
       OR NEW."result_document_id" IS DISTINCT FROM OLD."result_document_id"
       OR NEW."result_sha256" IS DISTINCT FROM OLD."result_sha256"
       OR NEW."result_prepared_at" IS DISTINCT FROM OLD."result_prepared_at"
       OR NEW."result_prepared_by" IS DISTINCT FROM OLD."result_prepared_by"
       OR NEW."result_reviewed_at" IS DISTINCT FROM OLD."result_reviewed_at"
       OR NEW."result_reviewed_by" IS DISTINCT FROM OLD."result_reviewed_by"
       OR NEW."response_sent_at" IS DISTINCT FROM OLD."response_sent_at"
       OR NEW."response_method" IS DISTINCT FROM OLD."response_method"
       OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
       OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
       OR NEW."completed_by_staff" IS DISTINCT FROM OLD."completed_by_staff" THEN
      RAISE EXCEPTION 'Abgeschlossener DSGVO-Nachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_dsgvo_terminal_evidence()
  SET search_path = pg_catalog, public, app;

CREATE TRIGGER dsgvo_request_terminal_evidence_immutable
BEFORE INSERT OR UPDATE ON "dsgvo_request"
FOR EACH ROW EXECUTE FUNCTION app.protect_dsgvo_terminal_evidence();
