CREATE OR REPLACE FUNCTION app.enforce_xrechnung_document_invoice_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."invoice" i
     WHERE i."xrechnung_document_id" = OLD."id"
       AND (
         NEW."tenant_id" IS DISTINCT FROM i."tenant_id"
         OR NEW."client_id" IS DISTINCT FROM i."client_id"
         OR NEW."classification" IS DISTINCT FROM
              'GOBD_INVOICE'::public.document_classification
         OR NEW."mime_type" IS DISTINCT FROM 'application/xml'
         OR NEW."deleted_at" IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'Referenziertes XRechnung-Dokument darf seine Archivgrenze nicht verlassen.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;
