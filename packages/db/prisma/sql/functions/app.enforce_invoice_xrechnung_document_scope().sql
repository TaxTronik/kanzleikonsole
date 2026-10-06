CREATE OR REPLACE FUNCTION app.enforce_invoice_xrechnung_document_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  v_document_tenant UUID;
  v_document_client UUID;
  v_classification public.document_classification;
  v_mime_type TEXT;
  v_deleted_at TIMESTAMPTZ;
BEGIN
  IF NEW."xrechnung_document_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d."tenant_id", d."client_id", d."classification", d."mime_type", d."deleted_at"
    INTO v_document_tenant,
         v_document_client,
         v_classification,
         v_mime_type,
         v_deleted_at
    FROM public."document" d
   WHERE d."id" = NEW."xrechnung_document_id"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'XRechnung-Dokument ist nicht vorhanden.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_document_tenant IS DISTINCT FROM NEW."tenant_id"
     OR v_document_client IS DISTINCT FROM NEW."client_id"
     OR v_classification IS DISTINCT FROM 'GOBD_INVOICE'::public.document_classification
     OR v_mime_type IS DISTINCT FROM 'application/xml'
     OR v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'XRechnung-Dokument verletzt Tenant-, Mandanten- oder Archivgrenze.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;
