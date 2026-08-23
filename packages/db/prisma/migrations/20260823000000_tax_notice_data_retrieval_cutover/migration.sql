-- Historische Bekanntgabe zum Datenabruf nach § 122a Abs. 4 AO a.F.:
-- bei Erlass bis 31.12.2025 knüpft die Fiktion an die elektronische Benachrichtigung an;
-- bei bestrittenem/verspätetem Zugang ist der tatsächliche Abruf maßgeblich.
-- Für nach dem 31.12.2025 erlassene Verwaltungsakte gilt Bereitstellung + vier Tage.

ALTER TABLE public."tax_notice"
  ADD COLUMN "retrieval_issued_at" DATE,
  ADD COLUMN "retrieval_notification_date" DATE,
  ADD COLUMN "retrieval_notification_legacy_fallback" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "retrieval_notification_disputed_or_late" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "retrieved_at" DATE;

-- Altkompatibilität: Das bisherige Eingabeformular kannte nur notice_date und
-- received_at. Es wäre fachlich unzulässig, daraus nachträglich den Versandtag
-- der Benachrichtigung oder einen bestrittenen Zugang zu behaupten. Der explizite
-- Legacy-Fallback hält solche Zeilen les-/änderbar und erhält die vorhandene
-- Frist; Erlassdatum bleibt unbekannt und received_at wird lediglich
-- informationswahrend nach retrieved_at kopiert.
-- Der alte Trigger würde das UPDATE sonst als fristrelevante Änderung behandeln
-- und appeal_deadline nach seiner alten DATA_RETRIEVAL-Logik überschreiben.
ALTER TABLE public."tax_notice" DISABLE TRIGGER tax_notice_appeal_deadline_trigger;

UPDATE public."tax_notice"
SET
  "retrieval_issued_at" = NULL,
  "retrieval_notification_date" = NULL,
  "retrieval_notification_legacy_fallback" = true,
  "retrieval_notification_disputed_or_late" = false,
  "retrieved_at" = "received_at",
  "received_at" = NULL
WHERE "delivery_method" = 'DATA_RETRIEVAL';

ALTER TABLE public."tax_notice" ENABLE TRIGGER tax_notice_appeal_deadline_trigger;

ALTER TABLE public."tax_notice"
  DROP CONSTRAINT IF EXISTS "tax_notice_notification_evidence_check";

ALTER TABLE public."tax_notice"
  ADD CONSTRAINT "tax_notice_notification_evidence_check"
  CHECK (
    (
      "delivery_method" IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL')
      OR "received_at" IS NOT NULL
    )
    AND ("received_at" IS NULL OR "received_at" >= "notice_date")
    AND (
      "delivery_method" = 'DATA_RETRIEVAL'
      OR (
        "retrieval_issued_at" IS NULL
        AND
        "retrieval_notification_date" IS NULL
        AND "retrieval_notification_legacy_fallback" = false
        AND "retrieval_notification_disputed_or_late" = false
        AND "retrieved_at" IS NULL
      )
    )
    AND (
      "delivery_method" <> 'DATA_RETRIEVAL'
      OR (
        "received_at" IS NULL
        AND (
          "retrieval_notification_date" IS NULL
          OR "retrieval_notification_date" >= "notice_date"
        )
        AND ("retrieved_at" IS NULL OR "retrieved_at" >= "notice_date")
        AND (
          "retrieval_notification_legacy_fallback" = false
          OR (
            "retrieval_issued_at" IS NULL
            AND "retrieval_notification_date" IS NULL
            AND "retrieval_notification_disputed_or_late" = false
          )
        )
        AND (
          "retrieval_notification_legacy_fallback"
          OR (
            "retrieval_issued_at" IS NOT NULL
            AND "retrieval_issued_at" <= "notice_date"
            AND (
              (
                "retrieval_issued_at" < DATE '2026-01-01'
                AND "retrieval_notification_date" IS NOT NULL
              )
              OR (
                "retrieval_issued_at" >= DATE '2026-01-01'
                AND "retrieval_notification_date" IS NULL
                AND "retrieval_notification_disputed_or_late" = false
                AND "retrieved_at" IS NULL
              )
            )
          )
        )
      )
    )
  ) NOT VALID;

-- DB-Backstop für direkte Integrationen. Die App bleibt wegen der vollständigen
-- Feiertagsberechnung führend; der Trigger bildet insbesondere den gesetzlichen
-- Stichtag und den altrechtlichen Abruf-Ausnahmefall wahrheitsgemäß ab.
CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline() RETURNS TRIGGER AS $$
DECLARE
  notification_date DATE;
BEGIN
  -- Bei migriertem Altbestand fehlen Erlass- und Benachrichtigungsdatum. Jede
  -- Neuberechnung würde daher eine unbewiesene Rechtsfolge behaupten. Solange
  -- der Datensatz nicht vollständig fachlich korrigiert und der Marker bewusst
  -- entfernt wird, bleibt die vor der Migration gespeicherte Frist unverändert.
  IF TG_OP = 'UPDATE'
     AND OLD.retrieval_notification_legacy_fallback
     AND NEW.retrieval_notification_legacy_fallback THEN
    NEW.appeal_deadline := OLD.appeal_deadline;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.appeal_deadline IS NOT DISTINCT FROM OLD.appeal_deadline
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.legal_remedy_instruction_valid IS DISTINCT FROM OLD.legal_remedy_instruction_valid
       OR NEW.retrieval_issued_at IS DISTINCT FROM OLD.retrieval_issued_at
       OR NEW.retrieval_notification_date IS DISTINCT FROM OLD.retrieval_notification_date
       OR NEW.retrieval_notification_legacy_fallback IS DISTINCT FROM OLD.retrieval_notification_legacy_fallback
       OR NEW.retrieval_notification_disputed_or_late IS DISTINCT FROM OLD.retrieval_notification_disputed_or_late
       OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
     ) THEN
    NEW.appeal_deadline := NULL;
  END IF;

  IF NEW.appeal_deadline IS NULL THEN
    IF NEW.delivery_method NOT IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL') THEN
      IF NEW.received_at IS NULL THEN
        RAISE EXCEPTION 'received_at is required for service without a statutory fiction';
      END IF;
      notification_date := NEW.received_at;
    ELSIF NEW.delivery_method = 'DATA_RETRIEVAL' THEN
      IF NEW.retrieval_issued_at IS NULL THEN
        RAISE EXCEPTION 'retrieval_issued_at is required for data retrieval';
      ELSIF NEW.retrieval_issued_at >= DATE '2026-01-01' THEN
        notification_date := NEW.notice_date + 4;
      ELSIF NEW.retrieval_notification_disputed_or_late THEN
        -- Ohne nachgewiesenen Benachrichtigungszugang und ohne Abruf liegt
        -- nach AEAO 2025 zu § 122a noch keine Bekanntgabe vor.
        IF NEW.retrieved_at IS NULL THEN RETURN NEW; END IF;
        notification_date := NEW.retrieved_at;
      ELSE
        IF NEW.retrieval_notification_date IS NULL
           AND NOT NEW.retrieval_notification_legacy_fallback THEN
          RAISE EXCEPTION 'retrieval_notification_date is required before 2026';
        END IF;
        notification_date := COALESCE(NEW.retrieval_notification_date, NEW.notice_date) +
          CASE
            WHEN COALESCE(NEW.retrieval_notification_date, NEW.notice_date) < DATE '2025-01-01'
              THEN 3
            ELSE 4
          END;
      END IF;
    ELSE
      notification_date := CASE
        WHEN NEW.delivery_method = 'POST_ABROAD'
          THEN (NEW.notice_date + INTERVAL '1 month')::date
        ELSE NEW.notice_date +
          CASE WHEN NEW.notice_date < DATE '2025-01-01' THEN 3 ELSE 4 END
      END;
      IF NEW.received_at IS NOT NULL AND NEW.received_at > notification_date THEN
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

ALTER FUNCTION app.tax_notice_set_appeal_deadline()
  SET search_path = pg_catalog, public, pg_temp;

-- Der Legacy-Fallback ist ausschließlich das Ergebnis dieses Backfills. Neue
-- Integrationen müssen Erlass- und ggf. historisches Benachrichtigungsdatum liefern;
-- auch ein späteres Hochstufen eines Datensatzes auf "Legacy" wird verhindert.
CREATE OR REPLACE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.retrieval_notification_legacy_fallback THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.retrieval_notification_legacy_fallback
     AND OLD.retrieval_notification_legacy_fallback = false THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_guard_retrieval_legacy_fallback()
  SET search_path = pg_catalog, public, pg_temp;

-- PostgreSQL führt gleichartige Trigger alphabetisch aus. Das 00-Präfix stellt
-- sicher, dass ein gefälschter Legacy-Marker vor der Fristberechnung abgewiesen
-- wird und nicht hinter einer allgemeineren Nachweisprüfung verborgen bleibt.
CREATE TRIGGER tax_notice_00_retrieval_legacy_fallback_guard
  BEFORE INSERT OR UPDATE OF "retrieval_notification_legacy_fallback"
  ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback();

DROP TRIGGER IF EXISTS tax_notice_appeal_deadline_trigger ON public."tax_notice";
CREATE TRIGGER tax_notice_appeal_deadline_trigger
  BEFORE INSERT OR UPDATE OF
    "notice_date",
    "received_at",
    "delivery_method",
    "legal_remedy_instruction_valid",
    "retrieval_issued_at",
    "retrieval_notification_date",
    "retrieval_notification_legacy_fallback",
    "retrieval_notification_disputed_or_late",
    "retrieved_at"
  ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_set_appeal_deadline();
