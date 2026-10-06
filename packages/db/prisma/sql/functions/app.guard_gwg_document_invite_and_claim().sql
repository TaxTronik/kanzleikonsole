CREATE OR REPLACE FUNCTION app.guard_gwg_document_invite_and_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  authorized_finalization BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (OLD."gwg_destruction_requested_at" IS NOT NULL OR OLD."gwg_destroyed_at" IS NOT NULL)
       AND EXISTS (SELECT 1 FROM "tenant" t WHERE t."id" = OLD."tenant_id")
    THEN
      RAISE EXCEPTION 'GwG-Vernichtungsclaim/-nachweis darf nicht hart gelöscht werden.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."gwg_onboarding_invite_id" IS NOT NULL
     AND NEW."classification" <> 'GWG_EVIDENCE'
  THEN
    RAISE EXCEPTION 'Dokumente aus einem GwG-Invite müssen als GWG_EVIDENCE klassifiziert sein.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."gwg_onboarding_invite_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "gwg_onboarding_invite" inv
     WHERE inv."id" = NEW."gwg_onboarding_invite_id"
       AND inv."tenant_id" = NEW."tenant_id"
       AND inv."client_id" = NEW."client_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Invite gehört nicht zu Tenant und Mandant des Dokuments.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Die Vorwärtsprüfung am gwg_id_document schützt nur das Anlegen der
  -- Relation. Ohne diese Rückwärtsprüfung könnte ein bereits verknüpfter
  -- Beleg anschließend umklassifiziert oder in einen anderen Mandanten-/
  -- Tenant-Scope verschoben werden.
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1
      FROM "gwg_id_document" gid
      JOIN "gwg_check" gc ON gc."id" = gid."gwg_check_id"
     WHERE gid."document_id" = OLD."id"
       AND (
         NEW."classification" <> 'GWG_EVIDENCE'
         OR NEW."tenant_id" IS DISTINCT FROM gc."tenant_id"
         OR NEW."client_id" IS DISTINCT FROM gc."client_id"
       )
  ) THEN
    RAISE EXCEPTION 'Verknüpfter GwG-Beleg darf Klassifikation oder Tenant-/Mandanten-Scope nicht verlassen.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    authorized_finalization := COALESCE((
      current_setting('app.gwg_destroy_document_id', TRUE) = OLD."id"::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
      )
    ), FALSE);
  END IF;

  -- Ein bereits zugeordneter GwG-Beleg ist nicht nur inhaltlich, sondern auch
  -- in seiner Sichtbarkeit Teil des Pruefungs-Snapshots. Die Dokumentzeile ist
  -- beim UPDATE bereits exklusiv gesperrt; der Gegen-Guard am
  -- gwg_id_document nimmt dieselbe Zeile FOR SHARE. Dadurch serialisieren
  -- Zuordnung und Soft-Delete in beide Richtungen race-sicher. Das
  -- Wiederherstellen eines inkonsistenten Legacy-Altbestands bleibt erlaubt.
  IF TG_OP = 'UPDATE'
     AND OLD."deleted_at" IS NULL
     AND NEW."deleted_at" IS NOT NULL
     AND NOT authorized_finalization
     AND EXISTS (
       SELECT 1
         FROM public."gwg_id_document" gid
        WHERE gid."document_id" = OLD."id"
     )
  THEN
    RAISE EXCEPTION 'Zugeordneter GwG-Beleg darf nicht ausgeblendet werden; kontrollierte GwG-Vernichtung verwenden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."gwg_destruction_requested_at" IS NOT NULL
     AND OLD."gwg_destroyed_at" IS NULL
     AND (
       NEW."gwg_destruction_requested_at" IS DISTINCT FROM OLD."gwg_destruction_requested_at"
       OR NEW."gwg_destruction_requested_by" IS DISTINCT FROM OLD."gwg_destruction_requested_by"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
       OR NEW."classification" IS DISTINCT FROM OLD."classification"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."retention_until" IS DISTINCT FROM OLD."retention_until"
       OR NEW."gwg_onboarding_invite_id" IS DISTINCT FROM OLD."gwg_onboarding_invite_id"
       OR (
         (
           NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
           OR NEW."gwg_destroyed_at" IS DISTINCT FROM OLD."gwg_destroyed_at"
         )
         AND NOT authorized_finalization
       )
     )
  THEN
    RAISE EXCEPTION 'Vorgemerkter GwG-Vernichtungsclaim ist irreversibel.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."gwg_destroyed_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Endgültig vernichteter GwG-Beleg ist bis auf updated_at unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
