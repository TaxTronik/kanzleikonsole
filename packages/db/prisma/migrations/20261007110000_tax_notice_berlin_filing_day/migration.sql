-- TAX-NOTICE-APPEAL-001 / TAX-CONTROL-STATUS-001.
--
-- Produktentscheidung A3 (2026-10-07, Folgepunkt aus Review-Finding K-05): Der
-- Tag einer Einspruchs- oder Klageeinlegung und der weiteren gespeicherten
-- Verfahrenszeitpunkte (Abhilfe/Einspruchsentscheidung, Bestandskraft) ist der
-- Berliner Kalendertag. Eine Frist endet mit Ablauf ihres letzten Tages nach
-- gesetzlicher Zeit (§ 108 Abs. 1 AO i. V. m. § 188 BGB). Bisher zählte der
-- UTC-Tag des gespeicherten Zeitpunkts (`timestamp without time zone` in UTC,
-- `col::date`).
--
-- Das Formular speichert einen Ereignistag als UTC-Mitternacht; dessen Berliner
-- Tag ist derselbe, für diese Zeilen ändert sich nichts. Abweichen können nur
-- Altbestände mit einer Uhrzeit ab 23:00 Uhr UTC (Winterzeit) bzw. 22:00 Uhr UTC
-- (Sommerzeit): Sie gehören jetzt zum Berliner Folgetag. Eine Einlegung um
-- 23:30 Uhr UTC am Fristtag im Winter (00:30 Uhr am Folgetag in Berlin) gilt damit
-- als verspätet, eine Bestandskraft mit diesem Zeitpunkt als nach Fristablauf
-- festgestellt.
--
-- Geändert werden alle Stellen der Datenbank, die aus diesen Spalten einen Tag
-- ableiten: der Statusübergangs-Trigger und die beiden Constraints
-- tax_notice_legal_final_evidence_check und tax_notice_event_sequence_check.
-- Ausdruck: (("col" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date,
-- unabhängig von der TimeZone der Sitzung und gleich berlinCalendarDate in der
-- App (filingWithinDeadline, Kontrollbuch-Vorabfragen, Bescheid-Übergänge).
-- Beide Constraints bleiben wie bisher NOT VALID: Altbestand wird nicht geprüft,
-- jede neue oder geänderte Zeile schon. Die Bestandskraft-Constraint wird dadurch
-- nur nachsichtiger (der Berliner Tag liegt nie vor dem UTC-Tag); in der
-- Ereignisreihenfolge kann ein Altbestand mit später Uhrzeit vor einem
-- Folgeereignis desselben UTC-Tags liegen. Solche Zeilen werden nicht geändert,
-- sondern gezählt und als WARNING gemeldet; ihre nächste Änderung scheitert, bis
-- die Ereignisdaten fachlich berichtigt sind.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.tax_notice_require_progress_evidence().sql
BEGIN;

CREATE OR REPLACE FUNCTION app.tax_notice_require_progress_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  -- TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001: Der Tag eines gespeicherten
  -- Verfahrenszeitpunkts (timestamp without time zone in UTC) ist der Berliner
  -- Kalendertag. Eine Frist endet mit Ablauf ihres letzten Tages nach gesetzlicher
  -- Zeit (§ 108 Abs. 1 AO i. V. m. § 188 BGB); ab 23:00 Uhr UTC (Winterzeit) bzw.
  -- 22:00 Uhr UTC (Sommerzeit) gilt schon der Folgetag. Die Ableitung hängt nicht
  -- von der TimeZone der Sitzung ab und entspricht berlinCalendarDate in der App.
  legal_final_day date :=
    ((NEW.legal_final_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date;
  appeal_resolved_day date :=
    ((NEW.appeal_resolved_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date;
  klage_filed_day date :=
    ((NEW.klage_filed_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'BESTANDSKRAEFTIG'::public.tax_notice_status THEN
    IF OLD.status NOT IN (
      'GEPRUEFT'::public.tax_notice_status,
      'ABGEHOLFEN'::public.tax_notice_status,
      'ZURUECKGEWIESEN'::public.tax_notice_status,
      'KLAGE'::public.tax_notice_status
    ) THEN
      RAISE EXCEPTION 'bestandskraft is not permitted from the current procedure status';
    END IF;

    IF OLD.status = 'GEPRUEFT'::public.tax_notice_status AND (
      NEW.deadline_calculation_status <> 'CALCULATED'
      OR NEW.manual_review_required
      OR NEW.appeal_deadline IS NULL
      OR NEW.appeal_filed_at IS NOT NULL
      OR NEW.legal_final_at IS NULL
      OR legal_final_day <= NEW.appeal_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft without an appeal requires the elapsed, fully calculated appeal deadline';
    END IF;

    IF OLD.status = 'ZURUECKGEWIESEN'::public.tax_notice_status AND (
      OLD.klage_deadline IS NULL
      OR NEW.legal_final_at IS NULL
      OR legal_final_day <= OLD.klage_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft after an appeal decision requires the elapsed court deadline';
    END IF;
  END IF;

  IF OLD.status IN (
    'EINSPRUCH'::public.tax_notice_status,
    'ABGEHOLFEN'::public.tax_notice_status,
    'TEILABHILFE'::public.tax_notice_status,
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (NEW.appeal_filed_at IS NULL OR NEW.appeal_filed_by IS NULL) THEN
    RAISE EXCEPTION 'appeal filing evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'ABGEHOLFEN'::public.tax_notice_status
     AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'TEILABHILFE'::public.tax_notice_status
     AND (
       NEW.partial_relief_received_at IS NULL
       OR NEW.partial_relief_received_by IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence must be completed before status progress';
  END IF;

  IF NEW.partial_relief_received_at IS NOT NULL AND (
    (
      NEW.appeal_resolved_at IS NOT NULL
      AND appeal_resolved_day < NEW.partial_relief_received_at
    )
    OR (
      NEW.appeal_decision_received_at IS NOT NULL
      AND NEW.appeal_decision_received_at < NEW.partial_relief_received_at
    )
    OR (
      NEW.klage_filed_at IS NOT NULL
      AND klage_filed_day < NEW.partial_relief_received_at
    )
    OR (
      NEW.legal_final_at IS NOT NULL
      AND legal_final_day < NEW.partial_relief_received_at
    )
  ) THEN
    RAISE EXCEPTION 'procedure progress must not predate the partial relief receipt';
  END IF;

  IF OLD.status IN (
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (
    NEW.appeal_decision_received_at IS NULL
    OR NEW.appeal_decision_legal_remedy_instruction_valid IS NULL
    OR NEW.klage_deadline IS NULL
  ) THEN
    RAISE EXCEPTION 'appeal decision evidence must be completed before status progress';
  END IF;

  IF OLD.status IN (
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'final appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'KLAGE'::public.tax_notice_status
     AND (NEW.klage_filed_at IS NULL OR NEW.klage_filed_by IS NULL) THEN
    RAISE EXCEPTION 'court filing evidence must be completed before status progress';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER TABLE public."tax_notice"
  DROP CONSTRAINT "tax_notice_legal_final_evidence_check",
  ADD CONSTRAINT "tax_notice_legal_final_evidence_check"
  CHECK (
    (
      "status" = 'BESTANDSKRAEFTIG'::public."tax_notice_status"
      AND "legal_final_at" IS NOT NULL
      AND "legal_final_by" IS NOT NULL
      AND app.legal_final_reason_sufficient("legal_final_reason")
      AND (
        (
          "appeal_filed_at" IS NULL
          AND "deadline_calculation_status" = 'CALCULATED'
          AND NOT "manual_review_required"
          AND "appeal_deadline" IS NOT NULL
          AND (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            > "appeal_deadline"
          AND "reviewed_at" IS NOT NULL
          AND "reviewed_by" IS NOT NULL
        )
        OR (
          "appeal_filed_at" IS NOT NULL
          AND "appeal_filed_by" IS NOT NULL
          AND (
            "appeal_resolved_at" IS NOT NULL
            OR ("klage_filed_at" IS NOT NULL AND "klage_filed_by" IS NOT NULL)
          )
        )
      )
    )
    OR (
      "status" <> 'BESTANDSKRAEFTIG'::public."tax_notice_status"
      AND "legal_final_reason" IS NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT "tax_notice_event_sequence_check",
  ADD CONSTRAINT "tax_notice_event_sequence_check"
  CHECK (
    (
      "appeal_filed_at" IS NULL
      OR (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date >= "notice_date"
    )
    AND (
      "partial_relief_received_at" IS NULL
      OR (
        "appeal_filed_at" IS NOT NULL
        AND "partial_relief_received_at"
          >= (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
      )
    )
    AND (
      "appeal_decision_received_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR "appeal_decision_received_at"
        >= (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
    )
    AND (
      "appeal_decision_received_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR "appeal_decision_received_at" >= "partial_relief_received_at"
    )
    AND (
      "appeal_resolved_at" IS NULL
      OR "appeal_filed_at" IS NULL
      OR (("appeal_resolved_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        >= (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
    )
    AND (
      "appeal_resolved_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR (("appeal_resolved_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        >= "partial_relief_received_at"
    )
    AND (
      "klage_filed_at" IS NULL
      OR "appeal_decision_received_at" IS NULL
      OR (("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        >= "appeal_decision_received_at"
    )
    AND (
      "klage_filed_at" IS NULL
      OR "partial_relief_received_at" IS NULL
      OR (("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        >= "partial_relief_received_at"
    )
    AND (
      "legal_final_at" IS NULL
      OR (
        (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date >= "notice_date"
        AND (
          "appeal_filed_at" IS NULL
          OR (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            >= (("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        )
        AND (
          "appeal_resolved_at" IS NULL
          OR (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            >= (("appeal_resolved_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        )
        AND (
          "partial_relief_received_at" IS NULL
          OR (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            >= "partial_relief_received_at"
        )
        AND (
          "appeal_decision_received_at" IS NULL
          OR (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            >= "appeal_decision_received_at"
        )
        AND (
          "klage_filed_at" IS NULL
          OR (("legal_final_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            >= (("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
        )
      )
    )
  ) NOT VALID;

-- Unter FORCE ROW LEVEL SECURITY sieht nur eine Rolle mit SUPERUSER oder
-- BYPASSRLS den ganzen Bestand; sonst wäre die Zählung ohne Tenant-Kontext 0.
-- Gezählt wird mit dem gespeicherten Constraint-Ausdruck selbst (pg_get_expr).
DO $$
DECLARE
  check_expression text;
  affected bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    SELECT pg_catalog.pg_get_expr(c.conbin, c.conrelid)
      INTO STRICT check_expression
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.tax_notice'::regclass
       AND c.conname = 'tax_notice_event_sequence_check';
    EXECUTE format('SELECT count(*) FROM public.tax_notice WHERE NOT (%s)', check_expression)
      INTO affected;
    IF affected > 0 THEN
      RAISE WARNING 'tax_notice: % Bescheide mit Verfahrenszeitpunkten, die nach Berliner Kalendertag nicht in Ereignisreihenfolge liegen; ihre nächste Änderung scheitert an tax_notice_event_sequence_check, bis die Ereignisdaten fachlich berichtigt sind.', affected;
    END IF;
  ELSE
    RAISE NOTICE 'tax_notice: Ereignisreihenfolge des Altbestands nicht gezählt (Rolle umgeht RLS nicht).';
  END IF;
END
$$;

COMMIT;
