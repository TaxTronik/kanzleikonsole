CREATE OR REPLACE FUNCTION app.enforce_gwg_identity_assignment_on_verification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."identity_assignment_required" = FALSE THEN
      RAISE EXCEPTION 'Grandfathering ist ausschliesslich dem Migrations-Backfill vorbehalten.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'VERIFIED' OR NEW."verified_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue GwG-Pruefungen muessen vor VERIFIED zuerst als offener Check mit bestaetigter Identitaetszuordnung gespeichert werden.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Fuer bereits vernichtete Skelette entscheidet ausschliesslich der
  -- vollstaendige Immutability-Guard. So bleibt updated_at erlaubt und jede
  -- andere Mutation erhaelt die fachlich richtige Fehlermeldung.
  IF OLD."destroyed_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD."identity_assignment_required" = TRUE
     AND NEW."identity_assignment_required" = FALSE
  THEN
    RAISE EXCEPTION 'identity_assignment_required darf nach dem Cutover nicht deaktiviert werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'VERIFIED' AND NEW."status" = 'VERIFIED'
     AND NEW."identity_assignment_required"
         IS DISTINCT FROM OLD."identity_assignment_required"
  THEN
    RAISE EXCEPTION 'Der Grandfathering-Status eines verifizierten GwG-Checks ist unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Grandfathering endet unwiderruflich, sobald die historische Freigabe
  -- verlassen wird. Ein spaeteres Wieder-Verifizieren braucht echte Subjects.
  IF OLD."status" = 'VERIFIED' AND NEW."status" <> 'VERIFIED' THEN
    NEW."identity_assignment_required" := TRUE;
  END IF;

  IF NEW."verified_at" IS NOT NULL
     AND NEW."status" <> 'VERIFIED'
     AND OLD."status" <> 'VERIFIED'
  THEN
    RAISE EXCEPTION 'verified_at darf nur beim Uebergang auf VERIFIED gesetzt werden.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = 'VERIFIED' AND OLD."status" IS DISTINCT FROM 'VERIFIED' THEN
    IF NEW."identity_assignment_required" = FALSE
       OR NOT app.gwg_check_has_confirmed_identity(NEW."id")
    THEN
      RAISE EXCEPTION 'VERIFIED erfordert eine gueltige, explizit bestaetigte 1:1-Identitaetszuordnung.'
        USING ERRCODE = 'check_violation',
              HINT = 'Natural Client bzw. auftretenden Vertreter per stabiler UUID zuordnen und Ausweissatz bestaetigen.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
