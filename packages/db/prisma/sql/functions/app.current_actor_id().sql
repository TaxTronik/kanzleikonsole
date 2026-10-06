CREATE OR REPLACE FUNCTION app.current_actor_id()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v TEXT;
BEGIN
    v := current_setting('app.current_actor_id', TRUE);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::UUID;
END;
$function$;
