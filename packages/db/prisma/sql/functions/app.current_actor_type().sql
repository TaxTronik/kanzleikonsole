CREATE OR REPLACE FUNCTION app.current_actor_type()
 RETURNS text
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
    RETURN current_setting('app.current_actor_type', TRUE);
END;
$function$;
