CREATE OR REPLACE FUNCTION app.guard_mandate_immutable_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'mandate history is immutable'; END $function$;
