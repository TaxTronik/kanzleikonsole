CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
       OR NEW.recipient_country_code IS DISTINCT FROM OLD.recipient_country_code
       OR NEW.recipient_locality IS DISTINCT FROM OLD.recipient_locality
       OR NEW.recipient_local_holiday_dates IS DISTINCT FROM OLD.recipient_local_holiday_dates
       OR NEW.recipient_bavaria_assumption_applies IS DISTINCT FROM OLD.recipient_bavaria_assumption_applies
       OR NEW.authority_name IS DISTINCT FROM OLD.authority_name
       OR NEW.authority_country_code IS DISTINCT FROM OLD.authority_country_code
       OR NEW.authority_locality IS DISTINCT FROM OLD.authority_locality
       OR NEW.authority_local_holiday_dates IS DISTINCT FROM OLD.authority_local_holiday_dates
       OR NEW.authority_bavaria_assumption_applies IS DISTINCT FROM OLD.authority_bavaria_assumption_applies
       OR NEW.date_basis IS DISTINCT FROM OLD.date_basis
       OR NEW.delivery_evidence_status IS DISTINCT FROM OLD.delivery_evidence_status
       OR NEW.legal_remedy_instruction_status IS DISTINCT FROM OLD.legal_remedy_instruction_status
       OR NEW.access_status IS DISTINCT FROM OLD.access_status
       OR NEW.access_evidence_status IS DISTINCT FROM OLD.access_evidence_status
       OR NEW.recipient_region IS DISTINCT FROM OLD.recipient_region
       OR NEW.authority_region IS DISTINCT FROM OLD.authority_region
       OR NEW.recipient_holiday_context_status IS DISTINCT FROM OLD.recipient_holiday_context_status
       OR NEW.authority_holiday_context_status IS DISTINCT FROM OLD.authority_holiday_context_status
       OR NEW.retrieval_issued_at IS DISTINCT FROM OLD.retrieval_issued_at
       OR NEW.retrieval_notification_date IS DISTINCT FROM OLD.retrieval_notification_date
       OR NEW.retrieval_notification_status IS DISTINCT FROM OLD.retrieval_notification_status
       OR NEW.retrieval_notification_disputed_or_late IS DISTINCT FROM OLD.retrieval_notification_disputed_or_late
       OR NEW.retrieval_notification_legacy_fallback IS DISTINCT FROM OLD.retrieval_notification_legacy_fallback
       OR NEW.retrieval_consent_status IS DISTINCT FROM OLD.retrieval_consent_status
       OR NEW.retrieval_postal_request_status IS DISTINCT FROM OLD.retrieval_postal_request_status
       OR NEW.retrieval_postal_request_received_at IS DISTINCT FROM OLD.retrieval_postal_request_received_at
       OR NEW.retrieval_eligibility_2027_status IS DISTINCT FROM OLD.retrieval_eligibility_2027_status
       OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
     ) THEN
    NEW.appeal_deadline := NULL;
    NEW.calculated_notification_date := NULL;
    NEW.internal_risk_deadline := NULL;
    NEW.alternative_claimed_access_deadline := NULL;
    NEW.deadline_calculation_status := 'MANUAL_REVIEW';
    NEW.manual_review_required := true;
    -- Nach jeder Tatsachenänderung an einem Datenabruf bleibt auch eine
    -- mögliche §110-/Ausnahmeprüfung offen, bis die Engine den gesamten
    -- Sachverhalt neu bewertet. Beim Wechsel weg vom Datenabruf muss das
    -- quellspezifische Flag dagegen zwingend verschwinden.
    NEW.retrieval_reinstatement_review_required :=
      NEW.delivery_method = 'DATA_RETRIEVAL';
    NEW.manual_review_reason := concat_ws(
      E'\n',
      NULLIF(NEW.manual_review_reason, ''),
      'Fristrelevante Tatsachen wurden geändert; Kontrollvorschlag neu berechnen und prüfen.'
    );
  ELSIF TG_OP = 'UPDATE'
     AND (
       NEW.appeal_deadline IS DISTINCT FROM OLD.appeal_deadline
       OR NEW.calculated_notification_date IS DISTINCT FROM OLD.calculated_notification_date
       OR NEW.internal_risk_deadline IS DISTINCT FROM OLD.internal_risk_deadline
       OR NEW.alternative_claimed_access_deadline IS DISTINCT FROM OLD.alternative_claimed_access_deadline
       OR NEW.deadline_calculation_status IS DISTINCT FROM OLD.deadline_calculation_status
       OR NEW.deadline_calculation_version IS DISTINCT FROM OLD.deadline_calculation_version
       OR NEW.manual_review_required IS DISTINCT FROM OLD.manual_review_required
       OR NEW.retrieval_reinstatement_review_required IS DISTINCT FROM OLD.retrieval_reinstatement_review_required
     ) THEN
    -- Eine Neuberechnung darf den fail-closed Zustand ausschließlich über die
    -- SECURITY-DEFINER-Funktion unten verlassen. Der transaktionslokale Marker
    -- ist an genau einen Bescheid gebunden; zusätzlich muss der UPDATE unter
    -- der Tabellen-Owner-Rolle der Funktion laufen. Ein direkter App-UPDATE
    -- kann den Marker daher nicht durch set_config nachahmen.
    IF NOT (
      current_setting('app.tax_notice_deadline_reassessment_id', true)
        IS NOT DISTINCT FROM OLD.id::TEXT
      AND current_user = (
        SELECT pg_catalog.pg_get_userbyid(c.relowner)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = 'tax_notice'
           AND c.relkind IN ('r', 'p')
      )
    ) THEN
      RAISE EXCEPTION
        'deadline assessment outputs cannot be edited without an authorized engine reassessment';
    END IF;
  END IF;

  IF NEW.deadline_calculation_status = 'CALCULATED'
     AND (NEW.appeal_deadline IS NULL OR NEW.calculated_notification_date IS NULL) THEN
    RAISE EXCEPTION
      'CALCULATED requires calculated_notification_date and appeal_deadline from the legal assessment engine';
  END IF;

  RETURN NEW;
END;
$function$;
