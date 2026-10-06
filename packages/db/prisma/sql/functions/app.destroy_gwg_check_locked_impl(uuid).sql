CREATE OR REPLACE FUNCTION app.destroy_gwg_check_locked_impl(p_check_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  check_tenant UUID;
  check_client UUID;
  check_status public."gwg_status";
  check_verified_at TIMESTAMP;
  check_destroyed_at TIMESTAMP;
  check_updated_at TIMESTAMP;
  mandate_ended_at TIMESTAMP;
  client_allow_active BOOLEAN;
  client_onboarding_completed_at TIMESTAMPTZ;
  retention_start TIMESTAMP;
  now_utc TIMESTAMP := timezone('UTC', CURRENT_TIMESTAMP);
  destroyed_at_utc TIMESTAMPTZ;
  owner_count INTEGER := 0;
  id_document_count INTEGER := 0;
  invite_count INTEGER := 0;
  open_document_count INTEGER := 0;
  latest_owner_at TIMESTAMP;
  latest_id_document_at TIMESTAMP;
  latest_invite_at TIMESTAMP;
BEGIN
  SELECT gc."tenant_id", gc."client_id"
    INTO check_tenant, check_client
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Prüfung nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  IF app.current_tenant_id() IS NULL OR check_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Prüfung gehört nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('STAFF', 'SYSTEM') THEN
    RAISE EXCEPTION 'GwG-Vernichtung ist nur im Staff-/System-Kontext zulässig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() = 'STAFF' AND (
    app.current_actor_id() IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."staff_user" su
       WHERE su."id" = app.current_actor_id()
         AND su."tenant_id" = check_tenant
         AND su."active" = TRUE
    )
  ) THEN
    RAISE EXCEPTION 'Aktiver Staff-Akteur für GwG-Vernichtung nicht nachgewiesen.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Preserve Client -> Check -> Invites -> ID documents -> owners lock order.
  SELECT timezone('UTC', c."mandate_ended_at"), c."allow_active", c."onboarding_completed_at"
    INTO mandate_ended_at, client_allow_active, client_onboarding_completed_at
    FROM public."client" c
   WHERE c."id" = check_client
     AND c."tenant_id" = check_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Mandant nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT gc."status", gc."verified_at", gc."destroyed_at", gc."updated_at"
    INTO check_status, check_verified_at, check_destroyed_at, check_updated_at
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id
     AND gc."tenant_id" = check_tenant
     AND gc."client_id" = check_client
   FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Prüfung wurde parallel verschoben; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF check_destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GwG-Aufzeichnungen wurden bereits vernichtet.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM inv."id"
    FROM public."gwg_onboarding_invite" inv
   WHERE inv."gwg_check_id" = p_check_id
     AND inv."tenant_id" = check_tenant
     AND inv."client_id" = check_client
   ORDER BY inv."id"
   FOR UPDATE NOWAIT;
  PERFORM gid."id"
    FROM public."gwg_id_document" gid
   WHERE gid."gwg_check_id" = p_check_id
   ORDER BY gid."id"
   FOR UPDATE NOWAIT;
  PERFORM bo."id"
    FROM public."gwg_beneficial_owner" bo
   WHERE bo."gwg_check_id" = p_check_id
   ORDER BY bo."id"
   FOR UPDATE NOWAIT;

  SELECT COUNT(*)::INTEGER, MAX(bo."created_at")
    INTO owner_count, latest_owner_at
    FROM public."gwg_beneficial_owner" bo
   WHERE bo."gwg_check_id" = p_check_id;
  SELECT COUNT(*)::INTEGER, MAX(gid."created_at")
    INTO id_document_count, latest_id_document_at
    FROM public."gwg_id_document" gid
   WHERE gid."gwg_check_id" = p_check_id;
  SELECT COUNT(*)::INTEGER, MAX(inv."updated_at")
    INTO invite_count, latest_invite_at
    FROM public."gwg_onboarding_invite" inv
   WHERE inv."gwg_check_id" = p_check_id
     AND inv."tenant_id" = check_tenant
     AND inv."client_id" = check_client;

  SELECT COUNT(DISTINCT d."id")::INTEGER
    INTO open_document_count
    FROM public."document" d
   WHERE d."tenant_id" = check_tenant
     AND d."client_id" = check_client
     AND d."classification" = 'GWG_EVIDENCE'
     AND d."gwg_destroyed_at" IS NULL
     AND (
       EXISTS (
          SELECT 1 FROM public."gwg_id_document" gid
          WHERE gid."gwg_check_id" = p_check_id
            AND gid."document_id" = d."id"
       )
       OR EXISTS (
          SELECT 1 FROM public."gwg_onboarding_invite" inv
          WHERE inv."gwg_check_id" = p_check_id
            AND inv."id" = d."gwg_onboarding_invite_id"
            AND inv."tenant_id" = check_tenant
            AND inv."client_id" = check_client
       )
     );
  IF open_document_count > 0 THEN
    RAISE EXCEPTION 'Es existieren noch nicht vernichtete GwG-Datei-Belege.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF mandate_ended_at IS NOT NULL THEN
    retention_start := mandate_ended_at;
  ELSE
    IF COALESCE(client_allow_active, FALSE)
       OR client_onboarding_completed_at IS NOT NULL
       OR check_verified_at IS NOT NULL
       OR check_status = 'VERIFIED'
    THEN
      RAISE EXCEPTION 'Ohne Mandatsende ist eine etablierte oder jemals verifizierte Geschäftsbeziehung nicht löschfähig.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF check_status NOT IN ('DRAFT', 'IN_REVIEW', 'REJECTED', 'EXPIRED') THEN
      RAISE EXCEPTION 'Status der nie etablierten GwG-Erstprüfung ist nicht löschfähig.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The finding cannot end before a later child/invite update. This retains
    -- the conservative canonical start while extending eligible statuses only.
    retention_start := GREATEST(
      check_updated_at,
      latest_owner_at,
      latest_id_document_at,
      latest_invite_at
    );
  END IF;

  IF retention_start IS NULL
     OR now_utc < make_date(EXTRACT(YEAR FROM retention_start)::INTEGER + 6, 1, 1)::TIMESTAMP
  THEN
    RAISE EXCEPTION 'Reguläre fünfjährige GwG-Aufbewahrungsfrist ist noch nicht abgelaufen.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.gwg_destroy_check_id', p_check_id::TEXT, TRUE);

  UPDATE public."gwg_onboarding_invite"
     SET "invite_email" = ('vernichtet+' || "id"::TEXT || '@taxtronik.local')::public.citext,
         "invite_name" = 'VERNICHTET',
         "token_hash" = 'vernichtet-' || "id"::TEXT,
         "expires_at" = LEAST("expires_at", now_utc),
         "status" = 'EXPIRED',
         "submitted_ip" = NULL,
         "submitted_ua" = NULL,
         "uploaded_document_ids" = '[]'::JSONB,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "gwg_check_id" = p_check_id
     AND "tenant_id" = check_tenant
     AND "client_id" = check_client;

  DELETE FROM public."gwg_beneficial_owner"
   WHERE "gwg_check_id" = p_check_id;

  UPDATE public."gwg_id_document"
     SET "owner_name" = 'VERNICHTET',
         "number" = NULL,
         "issued_by" = NULL,
         "issue_date" = NULL,
         "expiry_date" = NULL,
         "notes" = NULL,
         "document_id" = NULL
   WHERE "gwg_check_id" = p_check_id;

  destroyed_at_utc := CURRENT_TIMESTAMP;
  UPDATE public."gwg_check"
     SET "risk_answers" = NULL,
         "risk_breakdown" = NULL,
         "notes" = NULL,
         "rejected_reason" = NULL,
         "legal_form" = NULL,
         "register_number" = NULL,
         "register_authority" = NULL,
         "no_register_entry" = FALSE,
         "representative_names" = ARRAY[]::TEXT[],
         "ownership_structure_notes" = NULL,
         "destroyed_at" = destroyed_at_utc,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_check_id;

  PERFORM set_config('app.gwg_destroy_check_id', '', TRUE);

  RETURN jsonb_build_object(
    'clientId', check_client,
    'status', check_status,
    'retentionStartedAt', retention_start,
    'destroyedAt', destroyed_at_utc,
    'beneficialOwners', owner_count,
    'idDocuments', id_document_count,
    'invitations', invite_count
  );
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION 'GwG-Prüfung wird parallel bearbeitet; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
END;
$function$;
