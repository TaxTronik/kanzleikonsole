CREATE OR REPLACE FUNCTION app.inbound_message_staff_visible(tid uuid, sid uuid, mid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
 SELECT app.expansion_staff_permission(tid,sid,'INBOUND_MAIL_MANAGE')
 AND EXISTS(SELECT 1 FROM public.inbound_message m JOIN public.inbound_mailbox b ON b.id=m.mailbox_id WHERE m.id=mid AND b.tenant_id=tid)
 AND NOT EXISTS(SELECT 1 FROM public.inbound_attachment a WHERE a.message_id=mid AND a.client_id IS NOT NULL AND NOT app.notification_staff_can_access_client(tid,sid,a.client_id))
$function$;
