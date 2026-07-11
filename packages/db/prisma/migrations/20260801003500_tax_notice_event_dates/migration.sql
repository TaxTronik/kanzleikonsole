-- =============================================================================
-- Fristennachweis für Einspruch und Klage.
--
-- Interne Statuswechsel sind kein Ersatz für den tatsächlichen Einreichungs-
-- bzw. Bekanntgabetag. Diese Felder halten die fristauslösenden/-wahrenden
-- Tatsachen samt dokumentierender Person fest. Klagefristen bleiben auch nach
-- Rechtskraft erhalten und verschwinden damit nicht aus dem Kontrollnachweis.
-- =============================================================================

ALTER TABLE "tax_notice"
  ADD COLUMN "appeal_filed_by" UUID,
  ADD COLUMN "appeal_decision_received_at" DATE,
  ADD COLUMN "appeal_decision_legal_remedy_instruction_valid" BOOLEAN,
  ADD COLUMN "legal_final_at" TIMESTAMP(3),
  ADD COLUMN "legal_final_by" UUID,
  ADD COLUMN "delivery_method" TEXT NOT NULL DEFAULT 'POST',
  ADD COLUMN "legal_remedy_instruction_valid" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "tax_notice"
  ADD CONSTRAINT "tax_notice_delivery_method_check"
  CHECK ("delivery_method" IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL', 'FORMAL', 'PERSONAL', 'OTHER')),
  ADD CONSTRAINT "tax_notice_notification_evidence_check"
  CHECK (
    (
      "delivery_method" IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL')
      OR "received_at" IS NOT NULL
    )
    AND ("received_at" IS NULL OR "received_at" >= "notice_date")
  ) NOT VALID;

-- DB-Backstop für Integrationen, die keine Frist mitsenden. Die App bleibt die
-- führende Berechnung (inkl. Wochenenden/Feiertagen); der Trigger verhindert
-- aber auch bei direktem Insert eine NULL- oder offensichtlich falsch
-- angesetzte Frist für die unterschiedlichen Bekanntgabewege.
CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline() RETURNS TRIGGER AS $$
DECLARE
  notification_date DATE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.appeal_deadline IS NOT DISTINCT FROM OLD.appeal_deadline
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.legal_remedy_instruction_valid IS DISTINCT FROM OLD.legal_remedy_instruction_valid
     ) THEN
    NEW.appeal_deadline := NULL;
  END IF;

  IF NEW.appeal_deadline IS NULL THEN
    IF NEW.delivery_method NOT IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL') THEN
      IF NEW.received_at IS NULL THEN
        RAISE EXCEPTION 'received_at is required for service without a statutory fiction';
      END IF;
      notification_date := NEW.received_at;
    ELSE
      notification_date := CASE
        WHEN NEW.delivery_method = 'POST_ABROAD'
          THEN (NEW.notice_date + INTERVAL '1 month')::date
        ELSE NEW.notice_date +
          CASE WHEN NEW.notice_date < DATE '2025-01-01' THEN 3 ELSE 4 END
      END;
      IF NEW.delivery_method IN ('POST', 'POST_ABROAD', 'ELECTRONIC')
         AND NEW.received_at IS NOT NULL
         AND NEW.received_at > notification_date THEN
        notification_date := NEW.received_at;
      END IF;
    END IF;

    NEW.appeal_deadline := (
      notification_date +
      CASE
        WHEN NEW.legal_remedy_instruction_valid THEN INTERVAL '1 month'
        ELSE INTERVAL '1 year'
      END
    )::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_set_appeal_deadline() SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS tax_notice_appeal_deadline_trigger ON "tax_notice";
CREATE TRIGGER tax_notice_appeal_deadline_trigger
  BEFORE INSERT OR UPDATE OF
    "notice_date", "received_at", "delivery_method", "legal_remedy_instruction_valid"
  ON "tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_set_appeal_deadline();

-- Für neue/aktualisierte Entscheidungen darf kein offener Klageweg ohne
-- tatsächlichen Bekanntgabetag und berechnete Frist entstehen. NOT VALID lässt
-- historischen Altbestand zunächst zu; PostgreSQL erzwingt die Bedingung aber
-- bereits für jede neu eingefügte oder aktualisierte Zeile.
ALTER TABLE "tax_notice"
  ADD CONSTRAINT "tax_notice_decision_deadline_check"
  CHECK (
    "status" NOT IN (
      'TEILABHILFE'::"tax_notice_status",
      'ZURUECKGEWIESEN'::"tax_notice_status",
      'KLAGE'::"tax_notice_status"
    )
    OR (
      "appeal_decision_received_at" IS NOT NULL
      AND "appeal_decision_legal_remedy_instruction_valid" IS NOT NULL
      AND "klage_deadline" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_appeal_filing_evidence_check"
  CHECK (
    "status" <> 'EINSPRUCH'::"tax_notice_status"
    OR ("appeal_filed_at" IS NOT NULL AND "appeal_filed_by" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_court_filing_evidence_check"
  CHECK (
    "status" <> 'KLAGE'::"tax_notice_status"
    OR ("klage_filed_at" IS NOT NULL AND "klage_filed_by" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_legal_final_evidence_check"
  CHECK (
    "status" <> 'RECHTSKRAEFTIG'::"tax_notice_status"
    OR ("legal_final_at" IS NOT NULL AND "legal_final_by" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "tax_notice_event_sequence_check"
  CHECK (
    ("appeal_filed_at" IS NULL OR "appeal_filed_at"::date >= "notice_date")
    AND (
      "appeal_decision_received_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR "appeal_decision_received_at" >= "appeal_filed_at"::date
    )
    AND (
      "appeal_resolved_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR "appeal_resolved_at"::date >= "appeal_filed_at"::date
    )
    AND (
      "klage_filed_at" IS NULL
      OR "appeal_decision_received_at" IS NULL
      OR "klage_filed_at"::date >= "appeal_decision_received_at"
    )
    AND (
      "legal_final_at" IS NULL
      OR (
        "legal_final_at"::date >= "notice_date"
        AND (
          "appeal_filed_at" IS NULL
          OR "legal_final_at"::date >= "appeal_filed_at"::date
        )
        AND (
          "appeal_resolved_at" IS NULL
          OR "legal_final_at"::date >= "appeal_resolved_at"::date
        )
        AND (
          "appeal_decision_received_at" IS NULL
          OR "legal_final_at"::date >= "appeal_decision_received_at"
        )
        AND (
          "klage_filed_at" IS NULL
          OR "legal_final_at"::date >= "klage_filed_at"::date
        )
      )
    )
  ) NOT VALID;

-- Offene Altverfahren dürfen nicht durch einen bloßen Statuswechsel aus den
-- NOT-VALID-Nachweispflichten herausfallen. Der Bedienpfad lässt die fehlenden
-- Tatsachendaten deshalb aus der Akte bestätigen; dieser Trigger ist der
-- Backstop für direkte Integrationen und verlangt die vollständige Kette im
-- selben UPDATE. Historische Daten werden ausdrücklich nicht geschätzt.
CREATE OR REPLACE FUNCTION app.tax_notice_require_progress_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN (
    'EINSPRUCH'::public.tax_notice_status,
    'ABGEHOLFEN'::public.tax_notice_status,
    'TEILABHILFE'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (NEW.appeal_filed_at IS NULL OR NEW.appeal_filed_by IS NULL) THEN
    RAISE EXCEPTION 'appeal filing evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'ABGEHOLFEN'::public.tax_notice_status
     AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status IN (
    'TEILABHILFE'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (
    NEW.appeal_resolved_at IS NULL
    OR NEW.appeal_decision_received_at IS NULL
    OR NEW.appeal_decision_legal_remedy_instruction_valid IS NULL
    OR NEW.klage_deadline IS NULL
  ) THEN
    RAISE EXCEPTION 'appeal decision evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'KLAGE'::public.tax_notice_status
     AND (NEW.klage_filed_at IS NULL OR NEW.klage_filed_by IS NULL) THEN
    RAISE EXCEPTION 'court filing evidence must be completed before status progress';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_require_progress_evidence()
  SET search_path = pg_catalog, public, pg_temp;

CREATE TRIGGER tax_notice_progress_evidence_trigger
  BEFORE UPDATE OF "status" ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_require_progress_evidence();
