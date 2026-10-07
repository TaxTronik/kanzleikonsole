CREATE OR REPLACE FUNCTION app.mail_outbox_resend(p_outbox_id uuid, p_expected_status public.mail_outbox_status, p_skip_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_changed INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR app.current_actor_type() IS DISTINCT FROM 'STAFF' THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_CONTEXT: Neuversand nur im Kanzleikontext.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_expected_status IS NULL
     OR p_expected_status NOT IN ('FAILED'::public.mail_outbox_status,
                                  'UNKNOWN'::public.mail_outbox_status) THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_STATUS: Nur fehlgeschlagene oder unklare Aufträge.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_skip_reason IS NULL THEN
    UPDATE public."mail_outbox"
       SET "status" = 'QUEUED',
           "attempt_count" = 0,
           "next_attempt_at" = now(),
           "accepted_at" = NULL,
           "recipients_attempted" = NULL,
           "recipients_accepted" = NULL,
           "escalated_at" = NULL,
           "last_error" = 'Manuell erneut zum Versand vorgemerkt.',
           "updated_at" = now()
     WHERE "id" = p_outbox_id
       AND "tenant_id" = v_tenant_id
       AND "status" = p_expected_status
       AND "payload" <> '{}'::jsonb;
  ELSE
    IF btrim(p_skip_reason) = '' THEN
      RAISE EXCEPTION 'MAIL_OUTBOX_RESEND_REASON: Begründung fehlt.'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE public."mail_outbox"
       SET "status" = 'SKIPPED',
           "payload" = '{}'::jsonb,
           "secret_vars_enc" = NULL,
           "next_attempt_at" = NULL,
           "last_error" = left('Nicht versendet: ' || btrim(p_skip_reason), 500),
           "updated_at" = now()
     WHERE "id" = p_outbox_id
       AND "tenant_id" = v_tenant_id
       AND "status" = p_expected_status;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$function$;
