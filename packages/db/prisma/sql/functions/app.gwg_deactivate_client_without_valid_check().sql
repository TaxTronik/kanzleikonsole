CREATE OR REPLACE FUNCTION app.gwg_deactivate_client_without_valid_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  affected_client UUID;
BEGIN
  affected_client := CASE WHEN TG_OP = 'DELETE' THEN OLD.client_id ELSE NEW.client_id END;

  UPDATE "client" c
     SET "allow_active" = FALSE,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE c."id" = affected_client
     AND c."allow_active" = TRUE
     AND NOT EXISTS (
       SELECT 1
         FROM "gwg_check" gc
        WHERE gc."client_id" = affected_client
          AND gc."tenant_id" = c."tenant_id"
          AND gc."status" = 'VERIFIED'
          AND gc."destroyed_at" IS NULL
          AND (gc."valid_until" IS NULL OR gc."valid_until" > NOW())
          AND (
            c."kind" = 'NATPERS'
            OR (
              c."kind" IN ('JURPERS', 'PERSGES')
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
     );

  -- Defense in Depth für einen theoretischen client_id-Wechsel.
  IF TG_OP = 'UPDATE' AND OLD.client_id IS DISTINCT FROM NEW.client_id THEN
    UPDATE "client" c
       SET "allow_active" = FALSE,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE c."id" = OLD.client_id
       AND c."allow_active" = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM "gwg_check" gc
         WHERE gc."client_id" = OLD.client_id
            AND gc."tenant_id" = c."tenant_id"
            AND gc."status" = 'VERIFIED'
            AND gc."destroyed_at" IS NULL
            AND (gc."valid_until" IS NULL OR gc."valid_until" > NOW())
            AND (
              c."kind" = 'NATPERS'
              OR (
                c."kind" IN ('JURPERS', 'PERSGES')
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
       );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
