CREATE OR REPLACE FUNCTION app.guard_inbound_attachment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.message_id,NEW.part,NEW.sha256,NEW.size_bytes,NEW.mime_type,NEW.filename) IS DISTINCT FROM (OLD.message_id,OLD.part,OLD.sha256,OLD.size_bytes,OLD.mime_type,OLD.filename) THEN RAISE EXCEPTION 'immutable inbound bytes'; END IF;
 IF app.current_actor_type()='STAFF' THEN
  IF TG_OP='INSERT' OR OLD.status NOT IN ('CLEAN','IMPORTING','IMPORTED') OR NEW.status NOT IN ('IMPORTING','IMPORTED') THEN RAISE EXCEPTION 'scanner release required'; END IF;
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN RAISE EXCEPTION 'immutable staging source'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.document_id IS NOT NULL AND (NEW.document_id,NEW.client_id) IS DISTINCT FROM (OLD.document_id,OLD.client_id) THEN RAISE EXCEPTION 'archive assignment already bound'; END IF;
 IF NEW.document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document d JOIN public.inbound_message m ON m.id=NEW.message_id JOIN public.inbound_mailbox b ON b.id=m.mailbox_id WHERE d.id=NEW.document_id AND d.client_id=NEW.client_id AND d.tenant_id=b.tenant_id) THEN RAISE EXCEPTION 'archive tenant/client mismatch'; END IF;
 RETURN NEW;
END $function$;
