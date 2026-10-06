CREATE OR REPLACE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.retrieval_notification_legacy_fallback THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.retrieval_notification_legacy_fallback
     AND NOT OLD.retrieval_notification_legacy_fallback THEN
    RAISE EXCEPTION 'retrieval_notification_legacy_fallback is reserved for migrated records';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.retrieval_notification_legacy_fallback
     AND NEW.retrieval_notification_legacy_fallback
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.date_basis IS DISTINCT FROM OLD.date_basis
       OR NEW.delivery_evidence_status IS DISTINCT FROM OLD.delivery_evidence_status
       OR NEW.legal_remedy_instruction_valid IS DISTINCT FROM OLD.legal_remedy_instruction_valid
       OR NEW.legal_remedy_instruction_status IS DISTINCT FROM OLD.legal_remedy_instruction_status
       OR NEW.access_status IS DISTINCT FROM OLD.access_status
       OR NEW.access_evidence_status IS DISTINCT FROM OLD.access_evidence_status
       OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
       OR NEW.recipient_country_code IS DISTINCT FROM OLD.recipient_country_code
       OR NEW.recipient_region IS DISTINCT FROM OLD.recipient_region
       OR NEW.recipient_locality IS DISTINCT FROM OLD.recipient_locality
       OR NEW.recipient_local_holiday_dates IS DISTINCT FROM OLD.recipient_local_holiday_dates
       OR NEW.recipient_bavaria_assumption_applies IS DISTINCT FROM OLD.recipient_bavaria_assumption_applies
       OR NEW.authority_name IS DISTINCT FROM OLD.authority_name
       OR NEW.authority_country_code IS DISTINCT FROM OLD.authority_country_code
       OR NEW.authority_region IS DISTINCT FROM OLD.authority_region
       OR NEW.authority_locality IS DISTINCT FROM OLD.authority_locality
       OR NEW.authority_local_holiday_dates IS DISTINCT FROM OLD.authority_local_holiday_dates
       OR NEW.authority_bavaria_assumption_applies IS DISTINCT FROM OLD.authority_bavaria_assumption_applies
       OR NEW.recipient_holiday_context_status IS DISTINCT FROM OLD.recipient_holiday_context_status
       OR NEW.authority_holiday_context_status IS DISTINCT FROM OLD.authority_holiday_context_status
       OR NEW.retrieval_issued_at IS DISTINCT FROM OLD.retrieval_issued_at
       OR NEW.retrieval_notification_date IS DISTINCT FROM OLD.retrieval_notification_date
       OR NEW.retrieval_notification_disputed_or_late IS DISTINCT FROM OLD.retrieval_notification_disputed_or_late
       OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
       OR NEW.retrieval_consent_status IS DISTINCT FROM OLD.retrieval_consent_status
       OR NEW.retrieval_postal_request_status IS DISTINCT FROM OLD.retrieval_postal_request_status
       OR NEW.retrieval_postal_request_received_at IS DISTINCT FROM OLD.retrieval_postal_request_received_at
       OR NEW.retrieval_eligibility_2027_status IS DISTINCT FROM OLD.retrieval_eligibility_2027_status
       OR NEW.retrieval_notification_status IS DISTINCT FROM OLD.retrieval_notification_status
       OR NEW.retrieval_reinstatement_review_required IS DISTINCT FROM OLD.retrieval_reinstatement_review_required
       OR NEW.calculated_notification_date IS DISTINCT FROM OLD.calculated_notification_date
       OR NEW.appeal_deadline IS DISTINCT FROM OLD.appeal_deadline
       OR NEW.internal_risk_deadline IS DISTINCT FROM OLD.internal_risk_deadline
       OR NEW.alternative_claimed_access_deadline IS DISTINCT FROM OLD.alternative_claimed_access_deadline
       OR NEW.deadline_calculation_status IS DISTINCT FROM OLD.deadline_calculation_status
       OR NEW.deadline_calculation_version IS DISTINCT FROM OLD.deadline_calculation_version
       OR NEW.manual_review_required IS DISTINCT FROM OLD.manual_review_required
     ) THEN
    RAISE EXCEPTION
      'legacy data-retrieval facts and preserved deadline are immutable until the fallback marker is removed';
  END IF;

  RETURN NEW;
END;
$function$;
