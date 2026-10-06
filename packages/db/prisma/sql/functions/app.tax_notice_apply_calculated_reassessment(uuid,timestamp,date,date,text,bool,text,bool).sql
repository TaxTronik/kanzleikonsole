CREATE OR REPLACE FUNCTION app.tax_notice_apply_calculated_reassessment(p_notice_id uuid, p_expected_updated_at timestamp without time zone, p_calculated_notification_date date, p_appeal_deadline date, p_deadline_calculation_version text, p_manual_review_required boolean, p_manual_review_reason text, p_retrieval_reinstatement_review_required boolean)
 RETURNS public.tax_notice
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  reassessed public."tax_notice"%ROWTYPE;
  bound_tenant_id UUID := app.current_tenant_id();
  bound_actor_id UUID := app.current_actor_id();
BEGIN
  IF bound_tenant_id IS NULL
     OR bound_actor_id IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR NOT EXISTS (
       SELECT 1
         FROM public."staff_user" staff
        WHERE staff."id" = bound_actor_id
          AND staff."tenant_id" = bound_tenant_id
          AND staff."active"
     ) THEN
    RAISE EXCEPTION 'deadline reassessment requires an active bound staff context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_expected_updated_at IS NULL
     OR p_calculated_notification_date IS NULL
     OR p_appeal_deadline IS NULL
     OR length(btrim(COALESCE(p_deadline_calculation_version, ''))) < 3
     OR p_manual_review_required IS NULL
     OR p_retrieval_reinstatement_review_required IS NULL
     OR (
       p_manual_review_required
       AND length(btrim(COALESCE(p_manual_review_reason, ''))) < 3
     )
     OR (
       NOT p_manual_review_required
       AND NULLIF(btrim(COALESCE(p_manual_review_reason, '')), '') IS NOT NULL
     )
     OR (
       p_retrieval_reinstatement_review_required
       AND NOT p_manual_review_required
     ) THEN
    RAISE EXCEPTION 'deadline reassessment contains an incomplete calculated result'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config(
    'app.tax_notice_deadline_reassessment_id',
    p_notice_id::TEXT,
    true
  );

  UPDATE public."tax_notice" AS notice
     SET "calculated_notification_date" = p_calculated_notification_date,
         "appeal_deadline" = p_appeal_deadline,
         "internal_risk_deadline" = NULL,
         "alternative_claimed_access_deadline" = NULL,
         "deadline_calculation_status" = 'CALCULATED',
         "deadline_calculation_version" = btrim(p_deadline_calculation_version),
         "manual_review_required" = p_manual_review_required,
         "manual_review_reason" = NULLIF(btrim(COALESCE(p_manual_review_reason, '')), ''),
         "retrieval_reinstatement_review_required" = p_retrieval_reinstatement_review_required,
         "updated_at" = timezone('UTC', clock_timestamp())
   WHERE notice."id" = p_notice_id
     AND notice."tenant_id" = bound_tenant_id
     AND notice."updated_at" IS NOT DISTINCT FROM p_expected_updated_at
     AND notice."deadline_calculation_status" = 'MANUAL_REVIEW'
     AND notice."appeal_deadline" IS NULL
     AND notice."calculated_notification_date" IS NULL
     AND notice."internal_risk_deadline" IS NULL
     AND notice."alternative_claimed_access_deadline" IS NULL
     AND notice."manual_review_required"
     AND position(
       'Fristrelevante Tatsachen wurden geändert; Kontrollvorschlag neu berechnen und prüfen.'
       IN COALESCE(notice."manual_review_reason", '')
     ) > 0
  RETURNING notice.* INTO reassessed;

  PERFORM set_config('app.tax_notice_deadline_reassessment_id', '', true);

  IF reassessed."id" IS NULL THEN
    RAISE EXCEPTION
      'deadline reassessment target is missing, stale or was not invalidated by an input change'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN reassessed;
END;
$function$;
