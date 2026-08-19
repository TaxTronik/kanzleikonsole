-- Ein Mandant darf eine versehentlich hochgeladene Datei nur solange wirklich
-- verwerfen, wie die zugehörige Einladung noch offen ist und der Beleg noch
-- keinem GwG-Snapshot zugeordnet wurde. Der enge SECURITY-DEFINER-Pfad ist
-- nötig, weil reguläre App-SQL-Pfade immutable DocumentVersion-Zeilen bewusst
-- weder verändern noch löschen dürfen.

CREATE OR REPLACE FUNCTION app.discard_open_gwg_onboarding_document(
  p_invite_id UUID,
  p_document_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  v_version_count INTEGER;
  v_deleted_count INTEGER;
BEGIN
  IF app.current_tenant_id() IS NULL OR app.current_actor_type() IS DISTINCT FROM 'SYSTEM' THEN
    RAISE EXCEPTION 'GwG-Onboarding-Belege dürfen nur im gebundenen Systemkontext verworfen werden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Invite und Dokument werden in derselben Reihenfolge wie Upload/Submit
  -- gesperrt. Die JSON-Zuordnung gehört zur Autorisierung und wird nicht bloß
  -- als nachgelagerte Aufräumarbeit behandelt.
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
     AND jsonb_typeof(inv."uploaded_document_ids") = 'array'
     AND inv."uploaded_document_ids" @> jsonb_build_array(p_document_id::TEXT)
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

  UPDATE public."gwg_onboarding_invite"
     SET "uploaded_document_ids" = COALESCE((
       SELECT jsonb_agg(entry.value)
         FROM jsonb_array_elements("uploaded_document_ids") AS entry(value)
        WHERE entry.value <> to_jsonb(p_document_id::TEXT)
     ), '[]'::jsonb),
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
$$;

REVOKE ALL ON FUNCTION app.discard_open_gwg_onboarding_document(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discard_open_gwg_onboarding_document(UUID, UUID) TO taxtronik_app;

-- Der Parent-Lock- und GwG-Zuordnungs-Guard bleibt unverändert streng. Nur die
-- oben definierte Funktion darf den noch unzugeordneten Invite-Beleg löschen.
CREATE OR REPLACE FUNCTION app.block_version_during_gwg_destruction()
RETURNS TRIGGER AS $$
DECLARE
  old_document UUID;
  new_document UUID;
  target_document UUID;
  authorized_delete BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_document := OLD."document_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_document := NEW."document_id";
  END IF;
  target_document := COALESCE(new_document, old_document);

  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document OR d."id" = new_document
   ORDER BY d."id"
   FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    authorized_delete := COALESCE((
      (
        current_setting('app.gwg_destroy_document_id', TRUE) = target_document::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
        )
      ) OR (
        current_setting('app.gwg_discard_document_id', TRUE) = target_document::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure(
             'app.discard_open_gwg_onboarding_document(uuid,uuid)'
           )
        )
      )
    ), FALSE);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public."gwg_id_document" gid
      JOIN public."gwg_check" gc ON gc."id" = gid."gwg_check_id"
      JOIN public."tenant" t ON t."id" = gc."tenant_id"
     WHERE gid."document_id" = old_document OR gid."document_id" = new_document
  ) AND NOT authorized_delete THEN
    RAISE EXCEPTION 'Zugeordneter GwG-Beweisinhalt ist unveraenderlich; neues Dokument anlegen und erneut zuordnen.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."document" d
     WHERE (d."id" = old_document OR d."id" = new_document)
       AND d."gwg_destruction_requested_at" IS NOT NULL
  ) AND NOT authorized_delete THEN
    RAISE EXCEPTION 'GwG-Dokument befindet sich in Vernichtung; neue Version nicht zulässig.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.block_version_during_gwg_destruction()
  SET search_path = pg_catalog, public, app, pg_temp;

-- Die allgemeine Immutable-Sperre prüft neben der Transaktionsmarke auch den
-- tatsächlichen SECURITY-DEFINER-Owner und den weiterhin offenen/unverknüpften
-- Invite-Zustand. Ein SET LOCAL allein kann die Ausnahme daher nicht öffnen.
CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
RETURNS TRIGGER AS $$
DECLARE
  authorized_document TEXT;
  discard_document TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
    IF (OLD.scan_status = 'PENDING'
        AND OLD.scan_completed_at IS NULL
        AND OLD.storage_version_id IS NULL
        AND NEW.scan_status = 'CLEAN'
        AND NEW.scan_completed_at IS NOT NULL
        AND NEW.storage_version_id IS NOT NULL
        AND btrim(NEW.storage_version_id) <> ''
        AND OLD.id IS NOT DISTINCT FROM NEW.id
        AND OLD.storage_bucket IS NOT DISTINCT FROM NEW.storage_bucket
        AND OLD.storage_key IS NOT DISTINCT FROM NEW.storage_key
        AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
        AND OLD.size_bytes IS NOT DISTINCT FROM NEW.size_bytes
        AND OLD.immutable IS NOT DISTINCT FROM NEW.immutable
        AND OLD.version_no IS NOT DISTINCT FROM NEW.version_no
        AND OLD.document_id IS NOT DISTINCT FROM NEW.document_id
        AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
        AND OLD.created_by_id IS NOT DISTINCT FROM NEW.created_by_id) THEN
      RETURN NEW;
    END IF;

    IF (OLD.id IS DISTINCT FROM NEW.id
        OR OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
        OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
        OR OLD.storage_version_id IS DISTINCT FROM NEW.storage_version_id
        OR OLD.sha256 IS DISTINCT FROM NEW.sha256
        OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
        OR OLD.immutable IS DISTINCT FROM NEW.immutable
        OR OLD.scan_status IS DISTINCT FROM NEW.scan_status
        OR OLD.scan_completed_at IS DISTINCT FROM NEW.scan_completed_at
        OR OLD.version_no IS DISTINCT FROM NEW.version_no
        OR OLD.document_id IS DISTINCT FROM NEW.document_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.created_by_id IS DISTINCT FROM NEW.created_by_id) THEN
      RAISE EXCEPTION 'document_version ist immutable, Inhaltsfelder dürfen nicht geändert werden'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE' AND OLD.immutable = TRUE) THEN
    authorized_document := current_setting('app.gwg_destroy_document_id', TRUE);
    IF authorized_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
       )
       AND EXISTS (
         SELECT 1 FROM public."document" d
          WHERE d."id" = OLD.document_id
            AND d."classification" = 'GWG_EVIDENCE'
            AND d."gwg_destruction_requested_at" IS NOT NULL
            AND d."gwg_destroyed_at" IS NULL
       ) THEN
      RETURN OLD;
    END IF;

    discard_document := current_setting('app.gwg_discard_document_id', TRUE);
    IF discard_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure(
            'app.discard_open_gwg_onboarding_document(uuid,uuid)'
          )
       )
       AND EXISTS (
         SELECT 1
           FROM public."document" d
           JOIN public."gwg_onboarding_invite" inv
             ON inv."id" = d."gwg_onboarding_invite_id"
          WHERE d."id" = OLD.document_id
            AND d."classification" = 'GWG_EVIDENCE'
            AND d."tenant_id" = app.current_tenant_id()
            AND inv."status" IN ('PENDING'::public.gwg_invite_status, 'STARTED'::public.gwg_invite_status)
            AND inv."expires_at" > CURRENT_TIMESTAMP
            AND NOT EXISTS (
              SELECT 1 FROM public."gwg_id_document" gid
               WHERE gid."document_id" = d."id"
            )
       ) THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION 'document_version ist immutable und darf nicht gelöscht werden'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_immutable_document_version()
  SET search_path = pg_catalog, public, app, pg_temp;
