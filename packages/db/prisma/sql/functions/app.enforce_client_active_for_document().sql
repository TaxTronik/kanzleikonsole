CREATE OR REPLACE FUNCTION app.enforce_client_active_for_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF NEW.client_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "client" c
       WHERE c.id = NEW.client_id AND c.allow_active = TRUE
    ) THEN
      RETURN NEW;
    END IF;

    IF NEW.classification = 'GWG_EVIDENCE'::document_classification THEN
      IF EXISTS (
        SELECT 1 FROM "gwg_onboarding_invite" inv
         WHERE inv.tenant_id = NEW.tenant_id
           AND inv.client_id = NEW.client_id
           AND inv.status IN ('PENDING', 'STARTED')
           AND inv.expires_at > now()
      ) THEN
        RETURN NEW;
      END IF;

      IF app.current_actor_type() IN ('STAFF', 'SYSTEM') AND EXISTS (
        SELECT 1 FROM "gwg_check" gc
         WHERE gc.tenant_id = NEW.tenant_id
           AND gc.client_id = NEW.client_id
           AND gc.status IN ('DRAFT', 'IN_REVIEW')
           AND gc.destroyed_at IS NULL
      ) THEN
        RETURN NEW;
      END IF;
    END IF;

    RAISE EXCEPTION 'Mandant % ist nicht aktiv (GwG-Schranke). Dokumentenanlage abgewiesen.', NEW.client_id
      USING ERRCODE = 'check_violation',
            HINT = 'Nur GWG_EVIDENCE ist bei aktiver Einladung oder offener Staff-Prüfung vor Aktivierung zulässig.';
  END IF;
  RETURN NEW;
END;
$function$;
