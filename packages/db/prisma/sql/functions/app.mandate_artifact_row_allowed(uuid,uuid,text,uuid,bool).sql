CREATE OR REPLACE FUNCTION app.mandate_artifact_row_allowed(tid uuid, cid uuid, akind text, svid uuid, payroll boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT EXISTS(SELECT 1 FROM client c WHERE c.id=cid AND tid=app.current_tenant_id() AND c.tenant_id=tid AND c.anonymized_at IS NULL AND (
 app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid)
 AND (NOT payroll OR app.expansion_staff_permission(tid,app.current_actor_id(),'PAYROLL_MANAGE'))
 AND ((akind='OFFBOARDING' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=tid AND s.active AND r.role IN('ADMIN','PARTNER')))
 OR (akind='STRUCTURE' AND NOT EXISTS(SELECT 1 FROM mandate_structure_node n LEFT JOIN client linked ON linked.id=n.linked_client_id WHERE n.version_id=svid AND n.linked_client_id IS NOT NULL AND (linked.anonymized_at IS NOT NULL OR NOT app.notification_staff_can_access_client(tid,app.current_actor_id(),n.linked_client_id))))))))
$function$;
