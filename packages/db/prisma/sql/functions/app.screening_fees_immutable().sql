CREATE OR REPLACE FUNCTION app.screening_fees_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN RAISE EXCEPTION 'Immutable snapshot: append a new finding or calculation'; END; $function$;
