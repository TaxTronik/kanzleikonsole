CREATE OR REPLACE FUNCTION app.invoice_protect_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Festschreibung: Rechnung % darf nicht gelöscht werden (Aufbewahrungspflicht).', OLD.number
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$function$;
