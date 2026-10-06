CREATE OR REPLACE FUNCTION app.assistance_history_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN RAISE EXCEPTION 'assistance history is append only'; END $function$;
