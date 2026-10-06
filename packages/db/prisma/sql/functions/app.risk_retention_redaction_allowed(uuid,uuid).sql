CREATE OR REPLACE FUNCTION app.risk_retention_redaction_allowed(tid uuid, cid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  SELECT app.current_actor_type() = 'STAFF'
    AND tid = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.staff_user s JOIN public.staff_role r ON r.staff_user_id = s.id
       WHERE s.id = app.current_actor_id() AND s.tenant_id = tid AND s.active
         AND r.role IN ('ADMIN', 'PARTNER')
    )
    AND EXISTS (
      SELECT 1 FROM public.client c WHERE c.id = cid AND c.tenant_id = tid
        AND c.kind = 'NATPERS' AND c.anonymized_at IS NOT NULL
        AND c.mandate_ended_at IS NOT NULL
        AND make_date(EXTRACT(YEAR FROM c.mandate_ended_at)::integer + 11, 1, 1)
          <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    )
$function$;
