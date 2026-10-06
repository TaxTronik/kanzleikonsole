CREATE OR REPLACE FUNCTION app.stbvv_export_same_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.stbvv_quote q JOIN public.invoice i ON i.id=NEW.invoice_id
   WHERE q.id=NEW.quote_id AND q.tenant_id=NEW.tenant_id
     AND i.tenant_id=q.tenant_id AND i.client_id=q.client_id
 ) THEN RAISE EXCEPTION 'Fee quote and invoice must belong to the same tenant and client'; END IF;
 RETURN NEW;
END; $function$;
