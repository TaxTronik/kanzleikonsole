-- =============================================================================
-- Breite, idempotente Recovery fuer partiell manuell reparierte 034-Installationen.
--
-- Reale Legacy-Deployments koennen 034 als applied fuehren, obwohl einzelne
-- Funktionen oder Trigger fehlen bzw. noch einen aelteren Koerper besitzen.
-- Zuerst werden alle sicher wiederherstellbaren GwG-Guards aus dem kanonischen
-- 034-Stand installiert. Danach werden die durch 043 erweiterten Identity- und
-- Cutover-Funktionen auf den aktuellen Stand gehoben. Der in 042 eingefuehrte
-- Lifecycle-Lock-Wrapper fuer app.destroy_gwg_check bleibt unangetastet.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS document_gwg_invite_scope_and_claim ON "document";
DROP TRIGGER IF EXISTS gwg_id_document_scope_and_claim ON "gwg_id_document";
DROP TRIGGER IF EXISTS gwg_invite_check_scope_and_claim ON "gwg_onboarding_invite";
DROP TRIGGER IF EXISTS client_freeze_gwg_claim ON "client";
DROP TRIGGER IF EXISTS gwg_check_freeze_gwg_claim ON "gwg_check";
DROP TRIGGER IF EXISTS gwg_check_verified_legal_snapshot_immutable ON "gwg_check";
DROP TRIGGER IF EXISTS gwg_beneficial_owner_verified_snapshot_immutable
  ON "gwg_beneficial_owner";
DROP TRIGGER IF EXISTS gwg_check_no_hard_delete ON "gwg_check";
DROP TRIGGER IF EXISTS gwg_check_fail_closed_client ON "gwg_check";
DROP TRIGGER IF EXISTS document_version_block_gwg_destruction ON "document_version";

-- Kanonische 034-Guards. destroy_gwg_check wird bewusst ausgespart: dessen
-- aktueller Lifecycle-Lock-Wrapper und Implementierung stammen aus 042.

CREATE OR REPLACE FUNCTION app.guard_gwg_document_invite_and_claim()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.guard_gwg_document_invite_and_claim()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER document_gwg_invite_scope_and_claim
BEFORE INSERT OR UPDATE OR DELETE ON "document"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_document_invite_and_claim();

CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_scope_and_claim()
RETURNS TRIGGER AS $$
DECLARE
  old_pending UUID;
  old_check_id UUID;
  new_check_id UUID;
  old_document_id UUID;
  new_document_id UUID;
  authorized_document_destruction BOOLEAN := FALSE;
  authorized_check_destruction BOOLEAN := FALSE;
  authorized_document_unlink BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
    old_document_id := OLD."document_id";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_check_id := NEW."gwg_check_id";
    new_document_id := NEW."document_id";
  END IF;

  -- Beim Tenant-Cascade koennen Client/Document bereits entfernt sein, waehrend
  -- ein SET-NULL-FK die neue Subject-Referenz am Ausweissnapshot loest. Sobald
  -- der Check keinen noch existierenden Tenant mehr besitzt, ist das keine
  -- fachliche Einzelmutation, sondern ausschliesslich die kontrollierte
  -- Parent-Kaskade. Die normalen FK-Trigger bleiben weiterhin wirksam.
  IF TG_OP <> 'INSERT' AND NOT EXISTS (
    SELECT 1
      FROM public."gwg_check" gc
      JOIN public."tenant" t ON t."id" = gc."tenant_id"
     WHERE gc."id" = old_check_id
  ) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- BEFORE-Trigger laufen vor der FK-Prüfung. Ohne einen eigenen Parent-Lock
  -- könnte ein INSERT den alten, noch nicht vernichteten Zustand lesen, erst
  -- anschließend am FK-KeyShare warten und nach Commit der Vernichtung als
  -- neue Kindzeile in das bereits vernichtete Skelett nachrutschen. Beide
  -- möglichen Parents werden sortiert gelockt, damit auch Reparenting keine
  -- Gegenlock-Reihenfolge erzeugt.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  -- Dasselbe gilt für den zweiphasigen Dokument-Claim: Relation und Claim
  -- müssen über denselben Parent-Lock serialisiert werden.
  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document_id OR d."id" = new_document_id
   ORDER BY d."id"
   FOR SHARE;

  IF TG_OP <> 'INSERT' THEN
    IF old_document_id IS NOT NULL THEN
      SELECT d."id" INTO old_pending
        FROM public."document" d
       WHERE d."id" = old_document_id
          AND d."gwg_destruction_requested_at" IS NOT NULL
          AND d."gwg_destroyed_at" IS NULL;

      authorized_document_destruction := old_pending IS NOT NULL AND COALESCE((
        current_setting('app.gwg_destroy_document_id', TRUE) = old_pending::TEXT
        AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
        )
      ), FALSE);
    END IF;

    authorized_check_destruction := COALESCE((
      current_setting('app.gwg_destroy_check_id', TRUE) = old_check_id::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
      )
    ), FALSE);
  END IF;

  -- Personenbezogene Ausweis-Snapshots bleiben nach einer Verifizierung auch
  -- im Status EXPIRED unveränderlich. Die Dokumentvernichtung darf lediglich
  -- die konkrete Belegrelation lösen; die Checkvernichtung darf den Snapshot
  -- innerhalb ihrer eng begrenzten SECURITY-DEFINER-Funktion anonymisieren.
  authorized_document_unlink :=
    TG_OP = 'UPDATE'
    AND authorized_document_destruction
    AND NEW."document_id" IS NULL
    AND OLD."document_id" = old_pending
    AND NEW."id" IS NOT DISTINCT FROM OLD."id"
    AND NEW."gwg_check_id" IS NOT DISTINCT FROM OLD."gwg_check_id"
    AND NEW."type" IS NOT DISTINCT FROM OLD."type"
    AND NEW."owner_name" IS NOT DISTINCT FROM OLD."owner_name"
    AND NEW."number" IS NOT DISTINCT FROM OLD."number"
    AND NEW."issued_by" IS NOT DISTINCT FROM OLD."issued_by"
    AND NEW."issue_date" IS NOT DISTINCT FROM OLD."issue_date"
    AND NEW."expiry_date" IS NOT DISTINCT FROM OLD."expiry_date"
    AND NEW."verified_at" IS NOT DISTINCT FROM OLD."verified_at"
    AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
    AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at";

  IF EXISTS (
    SELECT 1 FROM public."gwg_check" gc
     WHERE gc."id" IN (old_check_id, new_check_id)
       AND EXISTS (SELECT 1 FROM public."tenant" t WHERE t."id" = gc."tenant_id")
       AND (
         gc."verified_at" IS NOT NULL
         OR gc."status" = 'VERIFIED'
         OR gc."destroyed_at" IS NOT NULL
       )
  ) AND NOT authorized_check_destruction AND NOT authorized_document_unlink THEN
    RAISE EXCEPTION 'Verifizierter GwG-Ausweis-Snapshot ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."document_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public."document" d
      JOIN public."gwg_check" gc ON gc."id" = NEW."gwg_check_id"
     WHERE d."id" = NEW."document_id"
       AND d."tenant_id" = gc."tenant_id"
       AND d."client_id" = gc."client_id"
       AND d."classification" = 'GWG_EVIDENCE'
       AND d."deleted_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND d."gwg_destroyed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'GwG-ID-Dokument braucht einen verfügbaren GWG_EVIDENCE-Beleg aus demselben Tenant/Mandanten.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP <> 'INSERT' AND old_pending IS NOT NULL THEN
    IF NOT authorized_document_destruction THEN
      RAISE EXCEPTION 'GwG-Nachweis ist zur Vernichtung vorgemerkt; Verknüpfung ist eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."document_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."document" d
     WHERE d."id" = NEW."document_id"
       AND d."gwg_destruction_requested_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'GwG-Nachweis ist zur Vernichtung vorgemerkt; neue Verknüpfung ist unzulässig.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.guard_gwg_id_document_scope_and_claim()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_id_document_scope_and_claim
BEFORE INSERT OR UPDATE OR DELETE ON "gwg_id_document"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_scope_and_claim();

CREATE OR REPLACE FUNCTION app.guard_gwg_invite_check_scope_and_claim()
RETURNS TRIGGER AS $$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
  END IF;
  new_check_id := NEW."gwg_check_id";

  -- FK-KeyShare kommt erst nach BEFORE-Triggern. Den Check deshalb hier
  -- selbst sperren und destroyed_at nach einem etwaigen Warten neu lesen.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  IF NEW."gwg_check_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."gwg_check" gc
     WHERE gc."id" = NEW."gwg_check_id"
       AND gc."tenant_id" = NEW."tenant_id"
       AND gc."client_id" = NEW."client_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Check gehört nicht zu Tenant und Mandant der Einladung.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."gwg_check_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR new_check_id IS DISTINCT FROM old_check_id)
     AND EXISTS (
       SELECT 1 FROM public."gwg_check" gc
        WHERE gc."id" = new_check_id
          AND gc."destroyed_at" IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Invite darf keinem vernichteten GwG-Check neu zugeordnet werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public."document" d
     WHERE d."gwg_onboarding_invite_id" = OLD."id"
       AND d."gwg_destruction_requested_at" IS NOT NULL
       AND d."gwg_destroyed_at" IS NULL
  ) AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."gwg_check_id" IS DISTINCT FROM OLD."gwg_check_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Invite ist durch einen Vernichtungsclaim eingefroren.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."gwg_check_id" IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."gwg_check" gc
        WHERE gc."id" = OLD."gwg_check_id"
          AND gc."destroyed_at" IS NOT NULL
     )
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Invite eines vernichteten GwG-Checks ist bis auf updated_at unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.guard_gwg_invite_check_scope_and_claim()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_invite_check_scope_and_claim
BEFORE INSERT OR UPDATE ON "gwg_onboarding_invite"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_invite_check_scope_and_claim();

CREATE OR REPLACE FUNCTION app.freeze_gwg_claim_references()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'client' THEN
    IF (
      NEW."mandate_ended_at" IS DISTINCT FROM OLD."mandate_ended_at"
      OR (OLD."allow_active" = FALSE AND NEW."allow_active" = TRUE)
    ) AND EXISTS (
      SELECT 1 FROM "document" d
       WHERE d."client_id" = OLD."id"
         AND d."gwg_destruction_requested_at" IS NOT NULL
         AND d."gwg_destroyed_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'Mandant ist durch einen laufenden GwG-Vernichtungsclaim eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'gwg_check' THEN
    IF (
      NEW."client_id" IS DISTINCT FROM OLD."client_id"
      OR NEW."destroyed_at" IS DISTINCT FROM OLD."destroyed_at"
      OR (
        NEW."status" IS DISTINCT FROM OLD."status"
        AND NOT (OLD."status" = 'VERIFIED' AND NEW."status" = 'EXPIRED')
      )
      OR NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
    ) AND EXISTS (
      SELECT 1 FROM "document" d
       WHERE d."gwg_destruction_requested_at" IS NOT NULL
         AND d."gwg_destroyed_at" IS NULL
         AND (
           d."gwg_onboarding_invite_id" IN (
             SELECT inv."id" FROM "gwg_onboarding_invite" inv
              WHERE inv."gwg_check_id" = OLD."id"
           )
           OR d."id" IN (
             SELECT gid."document_id" FROM "gwg_id_document" gid
              WHERE gid."gwg_check_id" = OLD."id" AND gid."document_id" IS NOT NULL
           )
         )
    ) THEN
      RAISE EXCEPTION 'GwG-Check ist durch einen laufenden Vernichtungsclaim eingefroren.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.freeze_gwg_claim_references()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER client_freeze_gwg_claim
BEFORE UPDATE OF "mandate_ended_at", "allow_active" ON "client"
FOR EACH ROW
WHEN (
  OLD."mandate_ended_at" IS DISTINCT FROM NEW."mandate_ended_at"
  OR OLD."allow_active" IS DISTINCT FROM NEW."allow_active"
)
EXECUTE FUNCTION app.freeze_gwg_claim_references();

CREATE TRIGGER gwg_check_freeze_gwg_claim
BEFORE UPDATE OF "status", "verified_at", "destroyed_at", "client_id" ON "gwg_check"
FOR EACH ROW
WHEN (
  OLD."status" IS DISTINCT FROM NEW."status"
  OR OLD."verified_at" IS DISTINCT FROM NEW."verified_at"
  OR OLD."destroyed_at" IS DISTINCT FROM NEW."destroyed_at"
  OR OLD."client_id" IS DISTINCT FROM NEW."client_id"
)
EXECUTE FUNCTION app.freeze_gwg_claim_references();

-- Staff muss einen DRAFT/IN_REVIEW-Check mit den erforderlichen Nachweisen
-- befüllen können, bevor allow_active gesetzt werden darf. Die bisherige
-- Ausnahme kannte nur öffentliche Einladungen und machte den manuellen
-- Prüfpfad dadurch unmöglich. Andere Dokumentklassen bleiben gesperrt.
CREATE OR REPLACE FUNCTION app.enforce_client_active_for_document() RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.enforce_client_active_for_document() SET search_path = pg_catalog, public, app, pg_temp;

-- Auch ein formal VERIFIED gebliebenes, bereits vernichtetes Skelett darf die
-- Aktivierung niemals rechtfertigen.
CREATE OR REPLACE FUNCTION app.enforce_client_allow_active_requires_gwg()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.allow_active = TRUE THEN
    IF NOT EXISTS (
      SELECT 1 FROM "gwg_check" gc
       WHERE gc.client_id = NEW.id
         AND gc.tenant_id = NEW.tenant_id
         AND gc.status = 'VERIFIED'
         AND gc.destroyed_at IS NULL
         AND (gc.valid_until IS NULL OR gc.valid_until > NOW())
         AND (
           NEW.kind = 'NATPERS'
           OR (
             NEW.kind IN ('JURPERS', 'PERSGES')
             AND NULLIF(BTRIM(gc.legal_form), '') IS NOT NULL
             AND COALESCE(cardinality(gc.representative_names), 0) > 0
             AND NULLIF(BTRIM(gc.ownership_structure_notes), '') IS NOT NULL
             AND (
               gc.no_register_entry = TRUE
               OR (
                 NULLIF(BTRIM(gc.register_number), '') IS NOT NULL
                 AND NULLIF(BTRIM(gc.register_authority), '') IS NOT NULL
               )
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'client.allow_active=TRUE erfordert einen gültigen, verifizierten, nicht vernichteten gwg_check (Mandant: %)', NEW.id
        USING ERRCODE = 'check_violation',
              HINT = 'Erst GwG-Prüfung vollständig verifizieren, dann aktivieren.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.enforce_client_allow_active_requires_gwg()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE OR REPLACE FUNCTION app.protect_verified_gwg_legal_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  authorized_check_destruction BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."destroyed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue GwG-Prüfung darf keinen Vernichtungsvermerk tragen.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  authorized_check_destruction := COALESCE((
    current_setting('app.gwg_destroy_check_id', TRUE) = OLD."id"::TEXT
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(p.proowner)
        FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
    )
  ), FALSE);

  IF OLD."destroyed_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Vernichteter GwG-Check ist bis auf updated_at unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- destroyed_at ist selbst die irreversible Vernichtungsquittung und darf
  -- für keinen Check außerhalb der kontrollierten Funktion gesetzt/gelöscht
  -- werden. Sonst ließe sich die Fristprüfung durch ein direktes UPDATE
  -- umgehen oder ein bereits vernichteter Datensatz wiederbeleben.
  IF NEW."destroyed_at" IS DISTINCT FROM OLD."destroyed_at"
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'GwG-Vernichtungsvermerk darf nur kontrolliert gesetzt werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD."verified_at" IS NOT NULL OR OLD."status" = 'VERIFIED')
     AND (
       NEW."legal_form" IS DISTINCT FROM OLD."legal_form"
       OR NEW."register_number" IS DISTINCT FROM OLD."register_number"
       OR NEW."register_authority" IS DISTINCT FROM OLD."register_authority"
       OR NEW."no_register_entry" IS DISTINCT FROM OLD."no_register_entry"
       OR NEW."representative_names" IS DISTINCT FROM OLD."representative_names"
       OR NEW."ownership_structure_notes" IS DISTINCT FROM OLD."ownership_structure_notes"
     )
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Rechtsträger-Snapshot ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_verified_gwg_legal_snapshot()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_check_verified_legal_snapshot_immutable
BEFORE INSERT OR UPDATE ON "gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.protect_verified_gwg_legal_snapshot();

CREATE OR REPLACE FUNCTION app.protect_verified_gwg_beneficial_owner()
RETURNS TRIGGER AS $$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
  authorized_check_destruction BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_check_id := OLD."gwg_check_id";
    authorized_check_destruction := COALESCE((
      current_setting('app.gwg_destroy_check_id', TRUE) = old_check_id::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
      )
    ), FALSE);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_check_id := NEW."gwg_check_id";
  END IF;

  -- Parent vor der Zustandsprüfung sperren. Sonst kann ein Child-INSERT den
  -- BEFORE-Trigger passieren, am nachgelagerten FK warten und erst nach der
  -- Vernichtung committen.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM public."gwg_check" gc
     WHERE gc."id" IN (old_check_id, new_check_id)
       AND EXISTS (SELECT 1 FROM public."tenant" t WHERE t."id" = gc."tenant_id")
       AND (
         gc."verified_at" IS NOT NULL
         OR gc."status" = 'VERIFIED'
         OR gc."destroyed_at" IS NOT NULL
       )
  ) AND NOT authorized_check_destruction THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Berechtigten-Snapshot ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_verified_gwg_beneficial_owner()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_beneficial_owner_verified_snapshot_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "gwg_beneficial_owner"
FOR EACH ROW EXECUTE FUNCTION app.protect_verified_gwg_beneficial_owner();

CREATE OR REPLACE FUNCTION app.guard_gwg_check_hard_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Das Skelett ist der Vernichtungsnachweis. Nur die FK-Kaskade eines bereits
  -- gelöschten Tenants darf den Datensatz physisch mit entfernen.
  IF EXISTS (SELECT 1 FROM "tenant" t WHERE t."id" = OLD."tenant_id") THEN
    RAISE EXCEPTION 'GwG-Check darf nicht hart gelöscht werden; kontrollierte Vernichtung verwenden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.guard_gwg_check_hard_delete()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_check_no_hard_delete
BEFORE DELETE ON "gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_check_hard_delete();

-- ---------------------------------------------------------------------------
-- Fail-closed DB-Invariante: Verliert ein Mandant durch Status-/Gültigkeits-
-- Änderung oder Löschung den letzten gültigen VERIFIED-Check, wird
-- allow_active unmittelbar FALSE. Der bisherige Trigger schützte nur das
-- Aktivieren, nicht den nachträglichen Verlust der Voraussetzung.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.gwg_deactivate_client_without_valid_check()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.gwg_deactivate_client_without_valid_check()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE TRIGGER gwg_check_fail_closed_client
AFTER UPDATE OF "status", "valid_until", "client_id", "destroyed_at",
  "legal_form", "register_number", "register_authority", "no_register_entry",
  "representative_names", "ownership_structure_notes" OR DELETE
ON "gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.gwg_deactivate_client_without_valid_check();

-- Legacy-Remediation: Vor dieser Migration konnten Rechtsträger VERIFIED sein,
-- obwohl die nun verpflichtenden Register-/Vertretungs-Snapshots nicht
-- existierten. Solche Altfreigaben werden fail-closed beendet; ihre Substanz
-- bleibt im EXPIRED-Snapshot unverändert erhalten. Pro betroffenem Mandanten
-- wird ein frischer Review angelegt, sofern noch keiner offen ist.
WITH affected AS MATERIALIZED (
  SELECT gc."id", gc."tenant_id", gc."client_id"
    FROM "gwg_check" gc
    JOIN "client" c ON c."id" = gc."client_id"
   WHERE gc."status" = 'VERIFIED'
     AND gc."destroyed_at" IS NULL
     AND c."kind" IN ('JURPERS', 'PERSGES')
     AND (
       NULLIF(BTRIM(gc."legal_form"), '') IS NULL
       OR COALESCE(cardinality(gc."representative_names"), 0) = 0
       OR NULLIF(BTRIM(gc."ownership_structure_notes"), '') IS NULL
       OR (
         gc."no_register_entry" = FALSE
         AND (
           NULLIF(BTRIM(gc."register_number"), '') IS NULL
           OR NULLIF(BTRIM(gc."register_authority"), '') IS NULL
         )
       )
     )
), expired AS (
  UPDATE "gwg_check" gc
     SET "status" = 'EXPIRED', "updated_at" = CURRENT_TIMESTAMP
    FROM affected a
   WHERE gc."id" = a."id"
  RETURNING a."tenant_id", a."client_id"
)
INSERT INTO "gwg_check" ("tenant_id", "client_id", "status", "created_at", "updated_at")
SELECT DISTINCT e."tenant_id", e."client_id", 'IN_REVIEW'::gwg_status, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM expired e
 WHERE NOT EXISTS (
   SELECT 1 FROM "gwg_check" open_check
    WHERE open_check."client_id" = e."client_id"
      AND open_check."status" IN ('DRAFT', 'IN_REVIEW')
      AND open_check."destroyed_at" IS NULL
 );

-- ---------------------------------------------------------------------------
-- Atomare Vernichtung der personenbezogenen Check-Aufzeichnungen.
--
-- App-Code darf weder die Fristprüfung noch die Kindtabellen per Read/Write-
-- Sequenz selbst koordinieren. Die Funktion serialisiert Mandant, Check,
-- Invites und Kind-Snapshots, prüft Tenant/Akteur/Frist und vernichtet erst
-- danach in derselben Transaktion. Ein GUC dient ausschließlich als enges
-- Capability-Token für die Immutability-Trigger; CURRENT_USER muss zusätzlich
-- dem Owner dieser SECURITY-DEFINER-Funktion entsprechen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
RETURNS TRIGGER AS $$
DECLARE
  authorized_document TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
    IF (OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
        OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
        OR OLD.sha256 IS DISTINCT FROM NEW.sha256
        OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
        OR OLD.immutable IS DISTINCT FROM NEW.immutable
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
         SELECT 1 FROM "document" d
          WHERE d."id" = OLD.document_id
            AND d."classification" = 'GWG_EVIDENCE'
            AND d."gwg_destruction_requested_at" IS NOT NULL
            AND d."gwg_destroyed_at" IS NULL
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

CREATE OR REPLACE FUNCTION app.assert_gwg_document_destruction_due(p_document_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  document_tenant UUID;
  document_client UUID;
  document_classification public."document_classification";
  document_created TIMESTAMP;
  document_retention_until TIMESTAMP;
  document_deleted_at TIMESTAMPTZ;
  document_destroyed_at TIMESTAMPTZ;
  mandate_ended_at TIMESTAMP;
  invite_id UUID;
  invite_status TEXT;
  invite_expires_at TIMESTAMP;
  invite_check_id UUID;
  requested_at TIMESTAMPTZ;
  requested_by UUID;
  retention_start TIMESTAMP;
  now_utc TIMESTAMP := timezone('UTC', CURRENT_TIMESTAMP);
  has_ongoing_reference BOOLEAN;
  terminal_without_relationship BOOLEAN := FALSE;
  linked_check_count INTEGER;
BEGIN
  SELECT d."tenant_id", d."client_id", d."classification", d."created_at", d."retention_until",
         d."deleted_at", d."gwg_destroyed_at", c."mandate_ended_at",
         inv."id", inv."status"::TEXT, inv."expires_at", inv."gwg_check_id",
         d."gwg_destruction_requested_at", d."gwg_destruction_requested_by"
    INTO document_tenant, document_client, document_classification, document_created,
         document_retention_until, document_deleted_at, document_destroyed_at,
         mandate_ended_at, invite_id, invite_status, invite_expires_at,
         invite_check_id, requested_at, requested_by
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

  -- Serialisiert alle fristrelevanten Relationen hinter dem bereits exklusiv
  -- gelockten Dokument. Konkurrierende Updates, die den noch uncommitteten
  -- Claim zunächst nicht sehen, müssen zuerst committen; die folgenden
  -- Statements lesen dann unter READ COMMITTED deren neuen Zustand.
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

  SELECT c."mandate_ended_at",
         inv."id", inv."status"::TEXT, inv."expires_at", inv."gwg_check_id"
    INTO mandate_ended_at, invite_id, invite_status, invite_expires_at, invite_check_id
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
  -- NULL ist ausdrücklich fail-closed: Ohne belastbaren Object-Lock-Stichtag
  -- darf selbst eine vorgemerkte Vernichtung keine Bytes/Versionen entfernen.
  IF document_retention_until IS NULL OR document_retention_until > now_utc THEN
    RAISE EXCEPTION 'Object-Lock-Aufbewahrung ist nicht nachweisbar abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  retention_start := mandate_ended_at;
  IF retention_start IS NULL THEN
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
         AND (
           gc."status" IN ('DRAFT', 'IN_REVIEW', 'VERIFIED')
           OR (gc."status" = 'EXPIRED' AND gc."verified_at" IS NOT NULL)
         )
    ) INTO has_ongoing_reference;

    IF has_ongoing_reference THEN
      RAISE EXCEPTION 'GwG-Beleg wird noch von einer offenen oder verifizierten Prüfung benötigt.' USING ERRCODE = 'check_violation';
    END IF;

    IF invite_id IS NOT NULL THEN
      terminal_without_relationship :=
        invite_status IN ('CANCELLED', 'EXPIRED')
        OR (invite_status IN ('PENDING', 'STARTED') AND invite_expires_at <= now_utc)
        OR (
          invite_status = 'SUBMITTED'
          AND EXISTS (
            SELECT 1 FROM public."gwg_check" gc
             WHERE gc."id" = invite_check_id
               AND gc."tenant_id" = document_tenant
               AND gc."client_id" = document_client
               AND gc."destroyed_at" IS NULL
               AND (
                 gc."status" = 'REJECTED'
                 OR (gc."status" = 'EXPIRED' AND gc."verified_at" IS NULL)
               )
          )
        );
    END IF;

    IF NOT terminal_without_relationship THEN
      SELECT COUNT(*)::INTEGER
        INTO linked_check_count
        FROM public."gwg_id_document" gid
        JOIN public."gwg_check" gc ON gc."id" = gid."gwg_check_id"
       WHERE gid."document_id" = p_document_id
         AND gc."tenant_id" = document_tenant
         AND gc."client_id" = document_client
         AND gc."destroyed_at" IS NULL;

      terminal_without_relationship := linked_check_count > 0 AND NOT EXISTS (
        SELECT 1
          FROM public."gwg_id_document" gid
          JOIN public."gwg_check" gc ON gc."id" = gid."gwg_check_id"
         WHERE gid."document_id" = p_document_id
           AND gc."tenant_id" = document_tenant
           AND gc."client_id" = document_client
           AND gc."destroyed_at" IS NULL
           AND NOT (
             gc."status" = 'REJECTED'
             OR (gc."status" = 'EXPIRED' AND gc."verified_at" IS NULL)
           )
      );
    END IF;

    IF terminal_without_relationship THEN
      retention_start := document_created;
    END IF;
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
$$;

-- ---------------------------------------------------------------------------
-- Destroy-Basis-Recovery fuer Installationen, die 034/042 manuell als applied
-- markieren mussten. Die temporaere Funktion traegt den kanonischen 034-Kern.
-- 042s bestehender Kern wird nur behalten, wenn sein prosrc bytegleich ist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.destroy_gwg_check_034_recovery(p_check_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  check_tenant UUID;
  check_client UUID;
  check_status public."gwg_status";
  check_verified_at TIMESTAMP;
  check_destroyed_at TIMESTAMP;
  check_updated_at TIMESTAMP;
  mandate_ended_at TIMESTAMP;
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
  -- Scope zunächst ohne Lock ermitteln; nach dem Client-Lock wird der Check
  -- exklusiv gelockt und die Zuordnung erneut verifiziert.
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

  -- Einheitliche Lock-Reihenfolge: Client -> Check -> Invites -> Ausweise ->
  -- wirtschaftlich Berechtigte. Parent-Row-Locks blockieren zugleich neue FK-
  -- Kindzeilen und schließen die Read/Write-TOCTOU-Lücke.
  SELECT timezone('UTC', c."mandate_ended_at")
    INTO mandate_ended_at
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

  -- Ein Soft-Delete genügt nicht: Solange ein verknüpfter Datei-Beleg nicht
  -- über den kontrollierten Dokumentpfad tatsächlich vernichtet wurde, bleiben
  -- die Check-Aufzeichnungen erhalten.
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
    IF NOT (
      check_status = 'REJECTED'
      OR (check_status = 'EXPIRED' AND check_verified_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'Ohne Mandatsende ist nur eine nie verifizierte terminale Prüfung löschfähig.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Feststellung endet nicht vor einer später hinzugefügten Ausweis- oder
    -- Berechtigten-Aufzeichnung. updated_at allein wäre bei direkten/importierten
    -- Kindzeilen ein zu früher, fachlich falscher Fristbeginn.
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

  -- Auch die Einladung ist eine personenbezogene GwG-Aufzeichnung (Name,
  -- E-Mail, Token, Submit-IP/-UA und lose Dokument-IDs). Sie bleibt als
  -- relationsfähiges Nachweis-Skelett erhalten, trägt nach der Vernichtung aber
  -- keine Identifikatoren mehr und kann nicht weiter als aktive Einladung
  -- verwendet werden.
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
$$;

DO $destroy_recovery$
DECLARE
  canonical_source TEXT;
  wrapper_source TEXT;
  core_source TEXT;
  wrapper_exists BOOLEAN;
  core_exists BOOLEAN;
BEGIN
  SELECT p.prosrc
    INTO canonical_source
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'app.destroy_gwg_check_034_recovery(uuid)'::regprocedure;

  wrapper_exists :=
    pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NOT NULL;
  core_exists :=
    pg_catalog.to_regprocedure('app.destroy_gwg_check_locked_impl(uuid)') IS NOT NULL;

  IF wrapper_exists THEN
    SELECT p.prosrc INTO wrapper_source
      FROM pg_catalog.pg_proc p
     WHERE p.oid = 'app.destroy_gwg_check(uuid)'::regprocedure;
  END IF;
  IF core_exists THEN
    SELECT p.prosrc INTO core_source
      FROM pg_catalog.pg_proc p
     WHERE p.oid = 'app.destroy_gwg_check_locked_impl(uuid)'::regprocedure;
  END IF;

  IF NOT core_exists THEN
    IF wrapper_exists AND wrapper_source = canonical_source THEN
      ALTER FUNCTION app.destroy_gwg_check(UUID)
        RENAME TO destroy_gwg_check_locked_impl;
      DROP FUNCTION app.destroy_gwg_check_034_recovery(UUID);
    ELSE
      IF wrapper_exists THEN
        DROP FUNCTION app.destroy_gwg_check(UUID);
      END IF;
      ALTER FUNCTION app.destroy_gwg_check_034_recovery(UUID)
        RENAME TO destroy_gwg_check_locked_impl;
    END IF;
  ELSIF core_source IS DISTINCT FROM canonical_source THEN
    DROP FUNCTION app.destroy_gwg_check_locked_impl(UUID);
    ALTER FUNCTION app.destroy_gwg_check_034_recovery(UUID)
      RENAME TO destroy_gwg_check_locked_impl;
  ELSE
    DROP FUNCTION app.destroy_gwg_check_034_recovery(UUID);
  END IF;
END;
$destroy_recovery$;

ALTER FUNCTION app.destroy_gwg_check_locked_impl(UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION app.destroy_gwg_check_locked_impl(UUID)
  SECURITY DEFINER;
ALTER FUNCTION app.destroy_gwg_check_locked_impl(UUID)
  SET search_path = pg_catalog, public, app, pg_temp;
REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM taxtronik_app;

CREATE OR REPLACE FUNCTION app.destroy_gwg_check(p_check_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  check_tenant UUID;
  check_client UUID;
  lifecycle_lock_key TEXT;
BEGIN
  SELECT gc."tenant_id", gc."client_id"
    INTO check_tenant, check_client
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Pruefung nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  IF app.current_tenant_id() IS NULL OR check_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Pruefung gehoert nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  lifecycle_lock_key :=
    'gwg-check-lifecycle:' || check_tenant::TEXT || ':' || check_client::TEXT;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lifecycle_lock_key, 0)
  );

  RETURN app.destroy_gwg_check_locked_impl(p_check_id);
END;
$$;

ALTER FUNCTION app.destroy_gwg_check(UUID)
  OWNER TO CURRENT_USER;
ALTER FUNCTION app.destroy_gwg_check(UUID)
  SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.destroy_gwg_check(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(UUID) TO taxtronik_app;

COMMENT ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) IS
  'Interner GwG-Vernichtungskern; ausschliesslich ueber app.destroy_gwg_check(uuid) aufrufen.';
COMMENT ON FUNCTION app.destroy_gwg_check(UUID) IS
  'Vernichtet einen faelligen GwG-Check unter dem mandantenbezogenen Lifecycle-Advisory-Lock.';

CREATE OR REPLACE FUNCTION app.destroy_gwg_document_versions(p_document_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  PERFORM app.assert_gwg_document_destruction_due(p_document_id);
  PERFORM set_config('app.gwg_destroy_document_id', p_document_id::TEXT, TRUE);
  DELETE FROM public."document_version" WHERE "document_id" = p_document_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  UPDATE public."gwg_id_document" SET "document_id" = NULL
   WHERE "document_id" = p_document_id;
  UPDATE public."document"
     SET "title" = 'VERNICHTET',
         "mime_type" = 'application/x-destroyed',
         "deleted_at" = CURRENT_TIMESTAMP,
         "deleted_by_staff" = CASE
           WHEN app.current_actor_type() = 'STAFF' THEN app.current_actor_id()
           ELSE NULL
         END,
         "delete_reason" = 'GwG-Pflichtvernichtung nach Ablauf der Aufbewahrungsfrist',
         "gwg_destroyed_at" = CURRENT_TIMESTAMP,
         "gwg_destruction_error" = NULL,
         "shared_with_client_at" = NULL,
         "shared_by_staff" = NULL,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_document_id;
  PERFORM set_config('app.gwg_destroy_document_id', '', TRUE);
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION app.assert_gwg_document_destruction_due(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.destroy_gwg_document_versions(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assert_gwg_document_destruction_due(UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.destroy_gwg_document_versions(UUID) TO taxtronik_app;
-- Defense in Depth: normale App-SQL-Pfade dürfen Versionen nicht direkt
-- löschen. Die SECURITY-DEFINER-Funktion läuft mit den Rechten ihres Owners.
REVOKE DELETE ON TABLE "document_version" FROM taxtronik_app;

-- Während PENDING dürfen keine neuen Versionen mehr entstehen; sonst könnte
-- zwischen Object-Store-Löschung und DB-Finalisierung eine Version nachrutschen.
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

  -- Wie bei den GwG-Check-Kindern muss der Parent bereits im BEFORE-Trigger
  -- gelockt werden. FOR UPDATE serialisiert neue Versionen ausserdem mit dem
  -- Verifikationspfad, der alle Evidence-Dokumente FOR SHARE sperrt. Bei UPDATE
  -- werden Quelle und Ziel sortiert gesperrt, damit Reparenting keine
  -- Gegenlock-Reihenfolge erzeugt.
  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document OR d."id" = new_document
   ORDER BY d."id"
   FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    authorized_delete := COALESCE((
      current_setting('app.gwg_destroy_document_id', TRUE) = target_document::TEXT
      AND CURRENT_USER = (
          SELECT pg_get_userbyid(p.proowner)
            FROM pg_catalog.pg_proc p
           WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
      )
    ), FALSE);
  END IF;

  -- Schon die explizite Zuordnung referenziert den konkreten Beweisinhalt.
  -- Eine neue/veraenderte Version wuerde eine vorhandene Bestaetigung oder
  -- laufende Review unbemerkt auf andere Bytes zeigen lassen. Korrekt ist ein
  -- neues Dokument mit erneuter Zuordnung. Nur die kontrollierte
  -- Vernichtungsfunktion darf alte Versionen loeschen. Die Tenant-Kaskade
  -- bleibt erlaubt, sobald der Parent-Tenant nicht mehr existiert.
  IF EXISTS (
    SELECT 1
      FROM public."gwg_id_document" gid
      JOIN public."gwg_check" gc ON gc."id" = gid."gwg_check_id"
      JOIN public."tenant" t ON t."id" = gc."tenant_id"
     WHERE (gid."document_id" = old_document
        OR gid."document_id" = new_document)
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

CREATE TRIGGER document_version_block_gwg_destruction
BEFORE INSERT OR UPDATE OR DELETE ON "document_version"
FOR EACH ROW EXECUTE FUNCTION app.block_version_during_gwg_destruction();

-- 043-spezifische Guards werden checksum-stabil erst hier korrigiert.
CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_subject_and_set()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  check_client UUID;
  check_kind public."client_kind";
  subject_name TEXT;
  old_subject_count INTEGER := 0;
  new_subject_count INTEGER;
  locked_set UUID;
  authorized_check_destruction BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_subject_count := num_nonnulls(
      OLD."natural_client_subject_id",
      OLD."beneficial_owner_subject_id",
      OLD."representative_subject_id"
    );
  END IF;

  new_subject_count := num_nonnulls(
    NEW."natural_client_subject_id",
    NEW."beneficial_owner_subject_id",
    NEW."representative_subject_id"
  );

  -- FK-SET-NULL (Berechtigten-/Vertreterentfernung, auch im Tenant-Cascade)
  -- darf niemals eine alte Bestaetigung an einer nun referenzlosen Zeile
  -- stehen lassen. Das geschieht vor Parent-Lookups, weil diese waehrend einer
  -- Kaskade bereits leer sein koennen.
  IF TG_OP = 'UPDATE'
     AND old_subject_count = 1
     AND new_subject_count = 0
     AND NEW."identity_assignment_confirmed_at"
         IS NOT DISTINCT FROM OLD."identity_assignment_confirmed_at"
     AND NEW."identity_assignment_confirmed_by"
         IS NOT DISTINCT FROM OLD."identity_assignment_confirmed_by"
  THEN
    NEW."identity_assignment_confirmed_at" := NULL;
    NEW."identity_assignment_confirmed_by" := NULL;
  END IF;

  -- document_set_id ist eine globale UUID. Die Advisory-Locks schliessen die
  -- Write-Skew-Luecke des spaeteren deferred Consistency-Triggers.
  FOR locked_set IN
    SELECT DISTINCT candidate
      FROM UNNEST(ARRAY[
        CASE WHEN TG_OP = 'UPDATE' THEN OLD."document_set_id" ELSE NULL END,
        NEW."document_set_id"
      ]::UUID[]) AS sets(candidate)
     WHERE candidate IS NOT NULL
     ORDER BY candidate
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended('gwg-document-set:' || locked_set::TEXT, 0)
    );
  END LOOP;

  -- Die Check-Zeile wird vor allen Scope-Lookups gesperrt. Der bereits
  -- vorhandene Claim-Guard verwendet denselben Parent-Lock.
  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = NEW."gwg_check_id"
   FOR SHARE;

  SELECT gc."client_id", c."kind"
    INTO check_client, check_kind
    FROM public."gwg_check" gc
    JOIN public."client" c ON c."id" = gc."client_id"
   WHERE gc."id" = NEW."gwg_check_id";

  -- Beim Tenant-Hard-Delete koennen ON-DELETE-Aktionen des Dokument-FKs eine
  -- ID-Zeile kurz anfassen, nachdem ihr Check bereits kaskadiert wurde. Die
  -- Zeile selbst wird in demselben Statement ueber den Check-FK geloescht.
  IF check_client IS NULL
     AND TG_OP = 'UPDATE'
     AND NEW."gwg_check_id" IS NOT DISTINCT FROM OLD."gwg_check_id"
  THEN
    RETURN NEW;
  END IF;

  IF check_client IS NULL THEN
    RAISE EXCEPTION 'GwG-Ausweisdokument verweist auf keine gueltige Pruefung.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    authorized_check_destruction := COALESCE((
      current_setting('app.gwg_destroy_check_id', TRUE) = OLD."gwg_check_id"::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
      )
    ), FALSE);

    -- Die kontrollierte Check-Vernichtung anonymisiert owner_name. Dabei
    -- werden auch Natural-Client-Refs geloest; Random-Set-IDs duerfen bleiben.
    IF authorized_check_destruction AND NEW."owner_name" = 'VERNICHTET' THEN
      NEW."natural_client_subject_id" := NULL;
      NEW."beneficial_owner_subject_id" := NULL;
      NEW."representative_subject_id" := NULL;
      NEW."identity_assignment_confirmed_at" := NULL;
      NEW."identity_assignment_confirmed_by" := NULL;
      new_subject_count := 0;
    END IF;

    -- Eine bereits bestaetigte Zeile darf nicht mit derselben Bestaetigung an
    -- eine andere Person umgehaengt werden.
    IF ROW(
         NEW."natural_client_subject_id",
         NEW."beneficial_owner_subject_id",
         NEW."representative_subject_id"
       ) IS DISTINCT FROM ROW(
         OLD."natural_client_subject_id",
         OLD."beneficial_owner_subject_id",
         OLD."representative_subject_id"
       )
       AND NEW."identity_assignment_confirmed_at" IS NOT NULL
       AND NEW."identity_assignment_confirmed_at"
           IS NOT DISTINCT FROM OLD."identity_assignment_confirmed_at"
    THEN
      RAISE EXCEPTION 'Eine geaenderte Identitaetszuordnung muss neu bestaetigt werden.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."natural_client_subject_id" IS NOT NULL THEN
    IF NEW."natural_client_subject_id" IS DISTINCT FROM check_client
       OR check_kind <> 'NATPERS'
    THEN
      RAISE EXCEPTION 'Natural-Client-Subject gehoert nicht als natuerliche Person zu dieser GwG-Pruefung.'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    SELECT c."name" INTO subject_name
      FROM public."client" c
     WHERE c."id" = NEW."natural_client_subject_id";
  ELSIF NEW."beneficial_owner_subject_id" IS NOT NULL THEN
    SELECT bo."full_name" INTO subject_name
      FROM public."gwg_beneficial_owner" bo
     WHERE bo."id" = NEW."beneficial_owner_subject_id"
       AND bo."gwg_check_id" = NEW."gwg_check_id";
    IF subject_name IS NULL THEN
      RAISE EXCEPTION 'Wirtschaftlich-Berechtigten-Subject gehoert nicht zu dieser GwG-Pruefung.'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF NEW."representative_subject_id" IS NOT NULL THEN
    SELECT rep."full_name" INTO subject_name
      FROM public."gwg_representative" rep
     WHERE rep."id" = NEW."representative_subject_id"
       AND rep."gwg_check_id" = NEW."gwg_check_id";
    IF subject_name IS NULL THEN
      RAISE EXCEPTION 'Vertreter-Subject gehoert nicht zu dieser GwG-Pruefung.'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  -- Bei der expliziten Bestaetigung muss auch der Anzeigesnapshot zur aktuell
  -- referenzierten Person passen. Spaetere Namensaenderungen am Client machen
  -- den unveraenderlichen Snapshot nicht rueckwirkend falsch.
  IF NEW."identity_assignment_confirmed_at" IS NOT NULL
     AND LOWER(regexp_replace(BTRIM(NEW."owner_name"), '\s+', ' ', 'g'))
         IS DISTINCT FROM
         LOWER(regexp_replace(BTRIM(subject_name), '\s+', ' ', 'g'))
  THEN
    RAISE EXCEPTION 'owner_name passt nicht zum bestaetigten Identitaets-Subject.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_gwg_document_set_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."gwg_id_document" peer
     WHERE peer."document_set_id" = NEW."document_set_id"
       AND peer."id" <> NEW."id"
       AND (
         peer."gwg_check_id" IS DISTINCT FROM NEW."gwg_check_id"
         OR peer."type" IS DISTINCT FROM NEW."type"
         OR peer."owner_name" IS DISTINCT FROM NEW."owner_name"
         OR peer."natural_client_subject_id"
              IS DISTINCT FROM NEW."natural_client_subject_id"
         OR peer."beneficial_owner_subject_id"
              IS DISTINCT FROM NEW."beneficial_owner_subject_id"
         OR peer."representative_subject_id"
              IS DISTINCT FROM NEW."representative_subject_id"
         OR peer."number" IS DISTINCT FROM NEW."number"
         OR peer."issued_by" IS DISTINCT FROM NEW."issued_by"
         OR peer."issue_date" IS DISTINCT FROM NEW."issue_date"
         OR peer."expiry_date" IS DISTINCT FROM NEW."expiry_date"
         OR peer."verified_at" IS DISTINCT FROM NEW."verified_at"
         OR peer."identity_assignment_confirmed_at"
              IS DISTINCT FROM NEW."identity_assignment_confirmed_at"
         OR peer."identity_assignment_confirmed_by"
              IS DISTINCT FROM NEW."identity_assignment_confirmed_by"
       )
  ) THEN
    RAISE EXCEPTION 'Ein GwG-Dokumentset muss Check, Typ, Person und alle Ausweisdaten einheitlich abbilden.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app.gwg_check_has_confirmed_identity(p_check_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public."gwg_check" gc
      JOIN public."client" c ON c."id" = gc."client_id"
      JOIN public."gwg_id_document" gid ON gid."gwg_check_id" = gc."id"
      LEFT JOIN public."gwg_representative" rep
        ON rep."id" = gid."representative_subject_id"
       AND rep."gwg_check_id" = gid."gwg_check_id"
     WHERE gc."id" = p_check_id
       AND gc."destroyed_at" IS NULL
       AND gid."type" IN ('PERSONALAUSWEIS', 'REISEPASS')
       AND gid."document_set_id" IS NOT NULL
       AND gid."identity_assignment_confirmed_at" IS NOT NULL
       AND gid."identity_assignment_confirmed_by" IS NOT NULL
       AND gid."verified_at" IS NOT NULL
       AND NULLIF(BTRIM(gid."number"), '') IS NOT NULL
       AND NULLIF(BTRIM(gid."issued_by"), '') IS NOT NULL
       AND gid."issue_date" IS NOT NULL
       AND gid."expiry_date" IS NOT NULL
       AND gid."expiry_date" >= CURRENT_DATE
       AND (
         (
           c."kind" = 'NATPERS'
           AND gid."natural_client_subject_id" = gc."client_id"
           AND gid."beneficial_owner_subject_id" IS NULL
           AND gid."representative_subject_id" IS NULL
         )
         OR (
           c."kind" IN ('JURPERS', 'PERSGES')
           AND gid."natural_client_subject_id" IS NULL
           AND gid."beneficial_owner_subject_id" IS NULL
           AND rep."id" IS NOT NULL
           AND LOWER(regexp_replace(BTRIM(rep."full_name"), '\s+', ' ', 'g')) =
               LOWER(regexp_replace(
                 BTRIM(gc."representative_names"[rep."position" + 1]),
                 '\s+', ' ', 'g'
               ))
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public."gwg_id_document" member
           LEFT JOIN public."document" evidence
             ON evidence."id" = member."document_id"
          WHERE member."document_set_id" = gid."document_set_id"
            AND (
              member."gwg_check_id" IS DISTINCT FROM gid."gwg_check_id"
              OR member."type" IS DISTINCT FROM gid."type"
              OR member."owner_name" IS DISTINCT FROM gid."owner_name"
              OR member."natural_client_subject_id"
                   IS DISTINCT FROM gid."natural_client_subject_id"
              OR member."beneficial_owner_subject_id"
                   IS DISTINCT FROM gid."beneficial_owner_subject_id"
              OR member."representative_subject_id"
                   IS DISTINCT FROM gid."representative_subject_id"
              OR member."number" IS DISTINCT FROM gid."number"
              OR member."issued_by" IS DISTINCT FROM gid."issued_by"
              OR member."issue_date" IS DISTINCT FROM gid."issue_date"
              OR member."expiry_date" IS DISTINCT FROM gid."expiry_date"
              OR member."verified_at" IS DISTINCT FROM gid."verified_at"
              OR member."identity_assignment_confirmed_at"
                   IS DISTINCT FROM gid."identity_assignment_confirmed_at"
              OR member."identity_assignment_confirmed_by"
                   IS DISTINCT FROM gid."identity_assignment_confirmed_by"
              OR member."document_id" IS NULL
              OR member."identity_assignment_confirmed_at" IS NULL
              OR member."identity_assignment_confirmed_by" IS NULL
              OR member."verified_at" IS NULL
              OR NULLIF(BTRIM(member."number"), '') IS NULL
              OR NULLIF(BTRIM(member."issued_by"), '') IS NULL
              OR member."issue_date" IS NULL
              OR member."expiry_date" IS NULL
              OR member."expiry_date" < CURRENT_DATE
              OR evidence."id" IS NULL
              OR evidence."tenant_id" IS DISTINCT FROM gc."tenant_id"
              OR evidence."client_id" IS DISTINCT FROM gc."client_id"
              OR evidence."classification" IS DISTINCT FROM 'GWG_EVIDENCE'
              OR NOT EXISTS (
                SELECT 1
                  FROM public."document_version" current_version
                 WHERE current_version."document_id" = member."document_id"
                   AND current_version."scan_status" = 'CLEAN'
                   AND current_version."scan_completed_at" IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1
                       FROM public."document_version" newer_version
                      WHERE newer_version."document_id" = current_version."document_id"
                        AND newer_version."version_no" > current_version."version_no"
                   )
              )
              OR evidence."deleted_at" IS NOT NULL
              OR evidence."gwg_destruction_requested_at" IS NOT NULL
              OR evidence."gwg_destroyed_at" IS NOT NULL
            )
       )
  );
$$;

REVOKE ALL ON FUNCTION app.gwg_check_has_confirmed_identity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gwg_check_has_confirmed_identity(UUID) TO taxtronik_app;

CREATE OR REPLACE FUNCTION app.enforce_gwg_identity_assignment_on_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
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
$$;

-- 034s Aktivierungsfunktion wird auf das exakte 043/044-Cutover-Gate gehoben.
CREATE OR REPLACE FUNCTION app.enforce_client_allow_active_requires_gwg()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
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
$$;

-- Zuletzt die 043-bewussten Check-Guards; die oben wiederhergestellten Trigger
-- zeigen nach CREATE OR REPLACE automatisch auf diese aktuellen Koerper.
CREATE OR REPLACE FUNCTION app.protect_verified_gwg_legal_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  authorized_check_destruction BOOLEAN := FALSE;
  authorized_grandfather_exit BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."destroyed_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue GwG-Pruefung darf keinen Vernichtungsvermerk tragen.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  authorized_check_destruction := COALESCE((
    current_setting('app.gwg_destroy_check_id', TRUE) = OLD."id"::TEXT
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(p.proowner)
        FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
    )
  ), FALSE);

  -- Trigger 00_gwg_check_identity_verification_guard setzt beim ersten
  -- Verlassen eines grandfathered VERIFIED-Checks das Cutover-Flag auf true.
  -- Genau diese irreversible Richtung ist Teil des gueltigen Statuswechsels.
  authorized_grandfather_exit :=
    OLD."status" = 'VERIFIED'
    AND NEW."status" <> 'VERIFIED'
    AND OLD."identity_assignment_required" = FALSE
    AND NEW."identity_assignment_required" = TRUE;

  -- to_jsonb umfasst bewusst auch alle 043-Felder. Ein vernichteter Check ist
  -- bis auf updated_at vollstaendig unveraenderlich.
  IF OLD."destroyed_at" IS NOT NULL
     AND (to_jsonb(NEW) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')
  THEN
    RAISE EXCEPTION 'Vernichteter GwG-Check ist bis auf updated_at unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."destroyed_at" IS DISTINCT FROM OLD."destroyed_at"
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'GwG-Vernichtungsvermerk darf nur kontrolliert gesetzt werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (OLD."verified_at" IS NOT NULL OR OLD."status" = 'VERIFIED')
     AND (
       NEW."legal_form" IS DISTINCT FROM OLD."legal_form"
       OR NEW."register_number" IS DISTINCT FROM OLD."register_number"
       OR NEW."register_authority" IS DISTINCT FROM OLD."register_authority"
       OR NEW."no_register_entry" IS DISTINCT FROM OLD."no_register_entry"
       OR NEW."representative_names" IS DISTINCT FROM OLD."representative_names"
       OR NEW."ownership_structure_notes"
            IS DISTINCT FROM OLD."ownership_structure_notes"
       OR (
         NEW."identity_assignment_required"
           IS DISTINCT FROM OLD."identity_assignment_required"
         AND NOT authorized_grandfather_exit
       )
     )
     AND NOT authorized_check_destruction
  THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Rechtstraeger-Snapshot ist unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.guard_gwg_check_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  -- Das Skelett ist der Vernichtungsnachweis. Nur die FK-Kaskade eines bereits
  -- geloeschten Tenants darf den Datensatz physisch mit entfernen.
  IF EXISTS (
    SELECT 1 FROM public."tenant" t WHERE t."id" = OLD."tenant_id"
  ) THEN
    RAISE EXCEPTION 'GwG-Check darf nicht hart geloescht werden; kontrollierte Vernichtung verwenden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

-- Recovery stellt auch die 043-Invariante fuer Identitaetsaenderungen an
-- wirtschaftlich Berechtigten wieder her.
CREATE OR REPLACE FUNCTION app.invalidate_gwg_beneficial_owner_identity_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF ROW(
       NEW."full_name",
       NEW."birth_date",
       NEW."birth_place",
       NEW."residence",
       NEW."nationality"
     ) IS NOT DISTINCT FROM ROW(
       OLD."full_name",
       OLD."birth_date",
       OLD."birth_place",
       OLD."residence",
       OLD."nationality"
     )
  THEN
    RETURN NEW;
  END IF;

  WITH affected_sets AS MATERIALIZED (
    SELECT DISTINCT gid."document_set_id"
      FROM public."gwg_id_document" gid
     WHERE gid."beneficial_owner_subject_id" = NEW."id"
  )
  UPDATE public."gwg_id_document" member
     SET "identity_assignment_confirmed_at" = NULL,
         "identity_assignment_confirmed_by" = NULL,
         "verified_at" = NULL
    FROM affected_sets affected
   WHERE member."document_set_id" = affected."document_set_id"
     AND (
       member."identity_assignment_confirmed_at" IS NOT NULL
       OR member."identity_assignment_confirmed_by" IS NOT NULL
       OR member."verified_at" IS NOT NULL
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gwg_beneficial_owner_identity_assignment_invalidate
  ON public."gwg_beneficial_owner";
CREATE TRIGGER gwg_beneficial_owner_identity_assignment_invalidate
AFTER UPDATE OF "full_name", "birth_date", "birth_place", "residence", "nationality"
ON public."gwg_beneficial_owner"
FOR EACH ROW
EXECUTE FUNCTION app.invalidate_gwg_beneficial_owner_identity_assignment();

COMMIT;
