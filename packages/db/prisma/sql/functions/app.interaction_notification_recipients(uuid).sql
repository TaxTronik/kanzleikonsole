CREATE OR REPLACE FUNCTION app.interaction_notification_recipients(p_interaction_id uuid)
 RETURNS TABLE(staff_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 WITH context AS (
  SELECT i.* FROM public.client_interaction i JOIN public.client_contact c ON c.id=i.contact_id AND c.active
  WHERE i.id=p_interaction_id AND i.tenant_id=app.current_tenant_id() AND i.contact_id=app.current_actor_id()
    AND app.current_actor_type()='CLIENT_CONTACT' AND c.client_id=i.client_id AND c.tenant_id=i.tenant_id
 ), candidates AS (
  SELECT s.id,
   EXISTS(SELECT 1 FROM public.client_responsibility r WHERE r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.staff_id=s.id AND r.role='HAUPTBEARBEITER') AS main,
   s.id=i.created_by_staff AS creator,
   EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER')) AS admin
  FROM context i JOIN public.client c ON c.id=i.client_id JOIN public.staff_user s ON s.tenant_id=i.tenant_id AND s.active
  WHERE EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER'))
   OR EXISTS(SELECT 1 FROM public.client_responsibility r WHERE r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.staff_id=s.id AND r.role IN ('HAUPTBEARBEITER','BERUFSTRAEGER'))
   OR (NOT c.vertraulich AND NOT EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='access' AND t.value->>'clientAccessMode'='RESTRICTED'))
 ) SELECT id FROM candidates WHERE CASE WHEN EXISTS(SELECT 1 FROM candidates WHERE main) THEN main WHEN EXISTS(SELECT 1 FROM candidates WHERE creator) THEN creator ELSE admin END;
$function$;
