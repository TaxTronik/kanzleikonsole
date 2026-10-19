CREATE OR REPLACE FUNCTION app.guard_tcms_systemakteur()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- MAIL-OUTBOX-001 (TCMS Stufe 4): Der Systemakteur eines Tenants wird einmal
  -- erzeugt und nie geändert. Das Tax-CMS führt seine Audit-Einträge unter
  -- dieser ID; eine geänderte ID wäre ein anderer Akteur. Nur der Lease des
  -- Zustelllaufs (lauf_halter, lauf_bis) darf sich ändern.
  IF (NEW.tenant_id, NEW.akteur_id, NEW.erstellt_am)
     IS DISTINCT FROM (OLD.tenant_id, OLD.akteur_id, OLD.erstellt_am) THEN
    RAISE EXCEPTION 'TCMS_SYSTEMAKTEUR_UNVERAENDERLICH: Der Systemakteur eines Tenants ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
