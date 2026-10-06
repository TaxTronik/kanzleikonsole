CREATE OR REPLACE FUNCTION app.audit_archive_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_archive ist insert-only (Hash-Chain-Belege)';
  RETURN NULL;
END;
$function$;
