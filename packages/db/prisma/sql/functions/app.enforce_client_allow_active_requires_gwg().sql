CREATE OR REPLACE FUNCTION app.enforce_client_allow_active_requires_gwg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF NEW."allow_active" = TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM public."gwg_check" gc
       WHERE gc."client_id" = NEW."id"
         AND gc."tenant_id" = NEW."tenant_id"
         AND gc."status" = 'VERIFIED'
         AND gc."destroyed_at" IS NULL
         AND (gc."valid_until" IS NULL OR gc."valid_until" > NOW())
         AND (
           gc."identity_assignment_required" = FALSE
           OR app.gwg_check_has_confirmed_identity(gc."id")
         )
         AND (
           NEW."kind" = 'NATPERS'
           OR (
             NEW."kind" IN ('JURPERS', 'PERSGES')
             AND NULLIF(BTRIM(gc."legal_form"), '') IS NOT NULL
             AND COALESCE(cardinality(gc."representative_names"), 0) > 0
             AND NULLIF(BTRIM(gc."ownership_structure_notes"), '') IS NOT NULL
             AND (
               gc."no_register_entry" = TRUE
               OR (
                 NULLIF(BTRIM(gc."register_number"), '') IS NOT NULL
                 AND NULLIF(BTRIM(gc."register_authority"), '') IS NOT NULL
               )
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'client.allow_active=TRUE erfordert einen gueltigen, verifizierten, nicht vernichteten gwg_check mit bestaetigter Identitaetszuordnung (Mandant: %)', NEW."id"
        USING ERRCODE = 'check_violation',
              HINT = 'Erst GwG-Pruefung und 1:1-Ausweiszuordnung vollstaendig verifizieren, dann aktivieren.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
