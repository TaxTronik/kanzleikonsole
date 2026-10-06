CREATE OR REPLACE FUNCTION app.portal_inbox_touch_thread()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  UPDATE public.portal_inbox_thread
     SET last_message_at = NEW.created_at,
         attention = CASE
           WHEN NEW.author_type = 'CLIENT_CONTACT' THEN 'STAFF'::public.portal_inbox_attention
           ELSE 'CLIENT'::public.portal_inbox_attention
         END,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = NEW.thread_id
     AND tenant_id = NEW.tenant_id
     AND client_id = NEW.client_id
     AND status = 'OPEN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offener Thread für Nachricht nicht mehr vorhanden';
  END IF;
  RETURN NEW;
END;
$function$;
