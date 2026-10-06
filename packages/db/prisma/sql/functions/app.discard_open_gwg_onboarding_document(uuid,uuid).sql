CREATE OR REPLACE FUNCTION app.discard_open_gwg_onboarding_document(p_invite_id uuid, p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  v_version_count INTEGER;
  v_deleted_count INTEGER;
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_actor_type() IS DISTINCT FROM 'SYSTEM' THEN
    RAISE EXCEPTION 'GwG-Onboarding-Belege dürfen nur im gebundenen Systemkontext verworfen werden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Invite und Dokument werden in derselben Reihenfolge wie Upload/Submit
  -- gesperrt. Die Zuordnung zur Einladung gehört zur Autorisierung; sie steht
  -- allein im Fremdschlüssel des Dokuments.
  PERFORM d."id"
    FROM public."gwg_onboarding_invite" inv
    JOIN public."document" d
      ON d."gwg_onboarding_invite_id" = inv."id"
     AND d."tenant_id" = inv."tenant_id"
     AND d."client_id" = inv."client_id"
   WHERE inv."id" = p_invite_id
     AND inv."tenant_id" = app.current_tenant_id()
     AND inv."status" IN ('PENDING'::public.gwg_invite_status, 'STARTED'::public.gwg_invite_status)
     AND inv."expires_at" > CURRENT_TIMESTAMP
     AND d."id" = p_document_id
     AND d."classification" = 'GWG_EVIDENCE'
     AND d."deleted_at" IS NULL
     AND d."gwg_destruction_requested_at" IS NULL
     AND d."gwg_destroyed_at" IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public."gwg_id_document" gid
        WHERE gid."document_id" = d."id"
     )
   FOR UPDATE OF inv, d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Onboarding-Beleg ist nicht mehr verwerfbar.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Nur ein finalisierter Upload ist verwerfbar: genau eine Version, CLEAN,
  -- mit Storage-Version. Ein noch laufender Upload (PENDING) scheitert hier.
  SELECT count(*)::INTEGER INTO v_version_count
    FROM public."document_version" dv
   WHERE dv."document_id" = p_document_id
     AND dv."immutable" = TRUE
     AND dv."scan_status" = 'CLEAN'
     AND dv."storage_version_id" IS NOT NULL
     AND btrim(dv."storage_version_id") <> '';
  IF v_version_count <> 1 OR (
    SELECT count(*) FROM public."document_version" dv
     WHERE dv."document_id" = p_document_id
  ) <> 1 THEN
    RAISE EXCEPTION 'GwG-Onboarding-Beleg besitzt keinen eindeutig löschbaren Speicherstand.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM set_config('app.gwg_discard_document_id', p_document_id::TEXT, TRUE);
  DELETE FROM public."document_version" WHERE "document_id" = p_document_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  -- Nur noch für ein App-Rollback auf das vorige Release, das die Liste liest.
  UPDATE public."gwg_onboarding_invite"
     SET "uploaded_document_ids" = CASE
           WHEN jsonb_typeof("uploaded_document_ids") = 'array'
             THEN "uploaded_document_ids" - p_document_id::TEXT
           ELSE "uploaded_document_ids"
         END,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_invite_id;

  DELETE FROM public."document" WHERE "id" = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Onboarding-Beleg konnte nicht verworfen werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM set_config('app.gwg_discard_document_id', '', TRUE);
  RETURN v_deleted_count;
END;
$function$;
