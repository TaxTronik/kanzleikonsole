CREATE OR REPLACE FUNCTION app.payroll_employer_access(pid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.payroll_intake i JOIN public.payroll_employer_grant g ON g.intake_id=i.id
 JOIN public.client_contact cc ON cc.id=g.contact_id JOIN public.client c ON c.id=i.client_id
 WHERE i.id=pid AND i.tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT'
 AND cc.id=app.current_actor_id() AND cc.tenant_id=i.tenant_id AND cc.client_id=i.client_id AND cc.active AND g.active
 AND g.tenant_id=i.tenant_id AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL);
$function$;
