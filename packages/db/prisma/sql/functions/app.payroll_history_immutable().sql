CREATE OR REPLACE FUNCTION app.payroll_history_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN RAISE EXCEPTION 'Payroll history is immutable'; END $function$;
