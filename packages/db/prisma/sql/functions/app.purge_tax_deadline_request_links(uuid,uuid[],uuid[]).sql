CREATE OR REPLACE FUNCTION app.purge_tax_deadline_request_links(p_tenant_id uuid, p_request_ids uuid[], p_origin_deadline_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  neutralized INTEGER;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TAX_DEADLINE_PURGE_TENANT: Tenant ist Pflicht.'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Freigabe fuer den unveraenderten Guard-Trigger: Er prueft zusaetzlich,
  -- dass current_user der Tabellen-Owner ist, was nur innerhalb dieser
  -- SECURITY-DEFINER-Funktion gilt.
  PERFORM pg_catalog.set_config('app.tax_deadline_notification_purge', 'on', true);

  -- Dieselbe Auswahl und derselbe Zielzustand wie bisher im Worker
  -- (dsgvo-retention, TAX-DEADLINE-AUTOREQUEST-001): noch bestehende
  -- Request-Pointer sowie bereits ORPHANED geloeste Ursprungszeilen.
  UPDATE public."tax_deadline" AS deadline
     SET "request_id" = NULL,
         "auto_request_notification_status" = 'NOT_REQUIRED',
         "auto_request_notification_attempt_count" = 0,
         "auto_request_notification_last_attempt_at" = NULL,
         "auto_request_notification_next_attempt_at" = NULL,
         "auto_request_notification_accepted_at" = NULL,
         "auto_request_notification_last_error" = NULL,
         "auto_request_notification_escalated_at" = NULL,
         "updated_at" = pg_catalog.timezone('UTC', pg_catalog.now())
   WHERE deadline."tenant_id" = p_tenant_id
     AND (
       deadline."request_id" = ANY (COALESCE(p_request_ids, ARRAY[]::UUID[]))
       OR (
         deadline."id" = ANY (COALESCE(p_origin_deadline_ids, ARRAY[]::UUID[]))
         AND deadline."request_id" IS NULL
         AND deadline."auto_request_notification_status" = 'ORPHANED'
       )
     );
  GET DIAGNOSTICS neutralized = ROW_COUNT;

  -- set_config(..., true) gilt sonst bis Transaktionsende fort; die Freigabe
  -- endet mit dieser Funktion.
  PERFORM pg_catalog.set_config('app.tax_deadline_notification_purge', '', true);
  RETURN neutralized;
END;
$function$;
