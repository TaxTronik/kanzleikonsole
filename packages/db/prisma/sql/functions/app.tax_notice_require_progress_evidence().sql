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
