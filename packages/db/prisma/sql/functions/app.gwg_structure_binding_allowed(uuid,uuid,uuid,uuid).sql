CREATE OR REPLACE FUNCTION app.gwg_structure_binding_allowed(tid uuid, cid uuid, checkid uuid, svid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT tid=app.current_tenant_id() AND EXISTS(SELECT 1 FROM gwg_check g JOIN client c ON c.id=g.client_id WHERE g.id=checkid AND g.tenant_id=tid AND g.client_id=cid AND c.anonymized_at IS NULL AND
 (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND g.destroyed_at IS NULL
 AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid)
 AND EXISTS(SELECT 1 FROM mandate_structure_version v WHERE v.id=svid AND v.tenant_id=tid AND v.client_id=cid)
 AND NOT EXISTS(SELECT 1 FROM mandate_structure_node n LEFT JOIN client linked ON linked.id=n.linked_client_id WHERE n.version_id=svid AND n.linked_client_id IS NOT NULL AND (linked.anonymized_at IS NOT NULL OR NOT app.notification_staff_can_access_client(tid,app.current_actor_id(),n.linked_client_id))))))
$function$;
