CREATE OR REPLACE FUNCTION app.enforce_client_active_for_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "client" c
        WHERE c.id = NEW.client_id AND c.allow_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Rechnungsanlage abgewiesen.',
            NEW.client_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$function$;
