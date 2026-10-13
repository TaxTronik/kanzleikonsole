CREATE OR REPLACE FUNCTION app.guard_dsgvo_export()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- DSGVO-CONTACT-EXPORT-001 (Welle 15, P-11): Auftrag der Worker-Erzeugung
  -- eines Kontaktpakets. Er gehört zu genau einem offenen Auskunfts- oder
  -- Portabilitätsantrag desselben Tenants über diesen Kontakt; Identität und
  -- ein fertiges Ergebnis sind unveränderlich, der Status läuft nur vorwärts.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NOT EXISTS (
      SELECT 1
        FROM public.dsgvo_request r
       WHERE r.id = NEW.request_id
         AND r.tenant_id = NEW.tenant_id
         AND r.subject_type = 'CLIENT_CONTACT'
         AND r.subject_ref_id = NEW.contact_id
         AND r.type IN ('ACCESS', 'PORTABILITY')
         AND r.status IN ('RECEIVED', 'IN_PROGRESS')
    ) THEN
      RAISE EXCEPTION 'dsgvo_export: kein offener Auskunftsantrag dieses Tenants für den Kontakt'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.request_id, NEW.contact_id, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.request_id, OLD.contact_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'dsgvo_export: Auftragsidentität ist unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD.status = 'REQUESTED' AND NEW.status IN ('REQUESTED', 'RUNNING', 'FAILED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING', 'DONE', 'FAILED'))
    OR (OLD.status IN ('DONE', 'FAILED') AND NEW.status = OLD.status)
  ) THEN
    RAISE EXCEPTION 'dsgvo_export: unzulässiger Statuswechsel % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('DONE', 'FAILED')
     AND (NEW.sha256, NEW.size_bytes, NEW.storage_bucket, NEW.storage_key,
          NEW.storage_version_id, NEW.finished_at, NEW.error)
         IS DISTINCT FROM
         (OLD.sha256, OLD.size_bytes, OLD.storage_bucket, OLD.storage_key,
          OLD.storage_version_id, OLD.finished_at, OLD.error) THEN
    RAISE EXCEPTION 'dsgvo_export: abgeschlossener Auftrag ist unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;
