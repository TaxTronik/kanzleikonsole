CREATE OR REPLACE FUNCTION app.enforce_tenant_client_pair_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  parent_tenant_id UUID;
BEGIN
  -- Nullable client_id (z. B. Kanzlei-Dokumente oder SET-NULL-FKs) ist ein
  -- ausdrücklicher Zustand und benötigt keine Parent-Paarprüfung.
  IF NEW."client_id" IS NULL THEN
    RETURN NEW;
  END IF;

  -- BEFORE-Trigger laufen vor der FK-Prüfung. Der Parent-Lock serialisiert
  -- INSERT/Reparenting mit Client-Löschung und Schlüsseländerungen und
  -- schützt die Prüfung davor, einen Zustand zu lesen, der vor dem eigenen
  -- Commit kippt. FOR KEY SHARE genügt dafür und lässt gewöhnliche
  -- Stammdaten-Updates des Mandanten parallel zu.
  SELECT c."tenant_id"
    INTO parent_tenant_id
    FROM public."client" c
   WHERE c."id" = NEW."client_id"
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mandant der referenzierten client_id ist im aktuellen DB-Scope nicht vorhanden (%).', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."tenant_id" IS DISTINCT FROM parent_tenant_id THEN
    RAISE EXCEPTION 'tenant_id und client_id gehören nicht zum selben Mandanten-Scope (%).', TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$function$;
