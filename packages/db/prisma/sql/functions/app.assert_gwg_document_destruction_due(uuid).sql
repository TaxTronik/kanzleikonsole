CREATE OR REPLACE FUNCTION app.assert_gwg_document_destruction_due(p_document_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  document_tenant UUID;
  document_client UUID;
  document_classification public."document_classification";
  document_created TIMESTAMP;
  document_retention_until TIMESTAMP;
  document_deleted_at TIMESTAMPTZ;
  document_destroyed_at TIMESTAMPTZ;
  mandate_ended_at TIMESTAMP;
  client_allow_active BOOLEAN;
  client_onboarding_completed_at TIMESTAMPTZ;
  invite_id UUID;
  invite_check_id UUID;
  requested_at TIMESTAMPTZ;
  requested_by UUID;
  retention_start TIMESTAMP;
  now_utc TIMESTAMP := timezone('UTC', CURRENT_TIMESTAMP);
  has_verified_reference BOOLEAN;
BEGIN
  SELECT d."tenant_id", d."client_id", d."classification", d."created_at", d."retention_until",
         d."deleted_at", d."gwg_destroyed_at", c."mandate_ended_at",
         c."allow_active", c."onboarding_completed_at",
         inv."id", inv."gwg_check_id",
         d."gwg_destruction_requested_at", d."gwg_destruction_requested_by"
    INTO document_tenant, document_client, document_classification, document_created,
         document_retention_until, document_deleted_at, document_destroyed_at,
         mandate_ended_at, client_allow_active, client_onboarding_completed_at,
         invite_id, invite_check_id, requested_at, requested_by
    FROM public."document" d
    LEFT JOIN public."client" c
      ON c."id" = d."client_id" AND c."tenant_id" = d."tenant_id"
    LEFT JOIN public."gwg_onboarding_invite" inv
      ON inv."id" = d."gwg_onboarding_invite_id"
     AND inv."tenant_id" = d."tenant_id"
     AND inv."client_id" = d."client_id"
   WHERE d."id" = p_document_id
   FOR UPDATE OF d;

  IF document_tenant IS NULL THEN
    RAISE EXCEPTION 'GwG-Dokument nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;
  IF app.current_tenant_id() IS NULL OR document_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Dokument gehört nicht zum aktuellen Tenant.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('STAFF', 'SYSTEM') THEN
    RAISE EXCEPTION 'GwG-Vernichtung ist nur im Staff-/System-Kontext zulässig.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() = 'STAFF' AND requested_by IS NULL THEN
    RAISE EXCEPTION 'GwG-Vernichtungsabsicht wurde keinem Staff zugeordnet.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF document_classification <> 'GWG_EVIDENCE' OR requested_at IS NULL THEN
    RAISE EXCEPTION 'GwG-Vernichtung wurde nicht ordnungsgemäß angefordert.' USING ERRCODE = 'check_violation';
  END IF;

  -- Preserve the canonical lock order behind the already locked document.
  PERFORM 1 FROM public."client" c
   WHERE c."id" = document_client AND c."tenant_id" = document_tenant
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_onboarding_invite" inv
   WHERE inv."id" = invite_id
     AND inv."tenant_id" = document_tenant
     AND inv."client_id" = document_client
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_id_document" gid
   WHERE gid."document_id" = p_document_id
   ORDER BY gid."id"
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_check" gc
   WHERE gc."tenant_id" = document_tenant
     AND gc."client_id" = document_client
     AND (
       gc."id" = invite_check_id
       OR gc."id" IN (
          SELECT gid."gwg_check_id" FROM public."gwg_id_document" gid
          WHERE gid."document_id" = p_document_id
       )
     )
   ORDER BY gc."id"
   FOR UPDATE NOWAIT;

  -- Re-read all relationship facts after the relation locks. Under READ
  -- COMMITTED this observes writers that committed while the NOWAIT locks were
  -- acquired and closes the same TOCTOU window as the canonical predecessor.
  SELECT c."mandate_ended_at", c."allow_active", c."onboarding_completed_at",
         inv."id", inv."gwg_check_id"
    INTO mandate_ended_at, client_allow_active, client_onboarding_completed_at,
         invite_id, invite_check_id
    FROM public."document" d
    LEFT JOIN public."client" c
      ON c."id" = d."client_id" AND c."tenant_id" = d."tenant_id"
    LEFT JOIN public."gwg_onboarding_invite" inv
      ON inv."id" = d."gwg_onboarding_invite_id"
     AND inv."tenant_id" = d."tenant_id"
     AND inv."client_id" = d."client_id"
   WHERE d."id" = p_document_id;

  IF document_deleted_at IS NOT NULL OR document_destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GwG-Dokument ist bereits gelöscht oder vernichtet.' USING ERRCODE = 'check_violation';
  END IF;
  IF document_retention_until IS NULL OR document_retention_until > now_utc THEN
    RAISE EXCEPTION 'Object-Lock-Aufbewahrung ist nicht nachweisbar abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  retention_start := mandate_ended_at;
  IF retention_start IS NULL THEN
    -- allow_active/onboarding_completed_at are durable evidence that a business
    -- relationship existed even if a later GwG expiry deactivated the client.
    IF COALESCE(client_allow_active, FALSE) OR client_onboarding_completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'GwG-Beleg gehört zu einer bestehenden oder früher etablierten Geschäftsbeziehung; Mandatsende fehlt.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public."gwg_check" gc
       WHERE gc."destroyed_at" IS NULL
         AND gc."tenant_id" = document_tenant
         AND gc."client_id" = document_client
         AND (
           gc."id" = invite_check_id
           OR EXISTS (
              SELECT 1 FROM public."gwg_id_document" gid
              WHERE gid."document_id" = p_document_id
                AND gid."gwg_check_id" = gc."id"
           )
         )
         AND (gc."status" = 'VERIFIED' OR gc."verified_at" IS NOT NULL)
    ) INTO has_verified_reference;

    IF has_verified_reference THEN
      RAISE EXCEPTION 'GwG-Beleg wird von einer verifizierten Geschäftsbeziehung benötigt.' USING ERRCODE = 'check_violation';
    END IF;

    -- In the remaining case no relationship was ever established. This covers
    -- stale DRAFT/IN_REVIEW first checks as well as REJECTED/EXPIRED checks and
    -- unlinked evidence; the finding year is the document creation year.
    retention_start := document_created;
  END IF;

  IF retention_start IS NULL THEN
    RAISE EXCEPTION 'Gesetzlicher GwG-Fristbeginn ist nicht belegt.' USING ERRCODE = 'check_violation';
  END IF;
  IF now_utc < make_date(EXTRACT(YEAR FROM retention_start)::INTEGER + 6, 1, 1)::TIMESTAMP THEN
    RAISE EXCEPTION 'Reguläre fünfjährige GwG-Aufbewahrungsfrist ist noch nicht abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN;
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION 'GwG-Belegrelationen werden parallel bearbeitet; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
END;
$function$;
