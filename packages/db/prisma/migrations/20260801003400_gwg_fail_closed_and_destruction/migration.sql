-- =============================================================================
-- GwG-Härtung: unveränderliche Prüf-Snapshots, fail-closed Aktivierung,
-- vollständige Rechtsträger-Identifizierung und wiederaufnehmbare Vernichtung.
-- =============================================================================

-- Mehrere Schutz-Trigger werden vor den kontrollierten Vernichtungsfunktionen
-- installiert. Ihre Owner-Prüfungen verwenden deshalb to_regprocedure(): Eine
-- noch nicht vorhandene Funktion ergibt NULL und damit fail-closed FALSE,
-- statt das Legacy-Backfill auf Bestandsdaten mit SQLSTATE 42883 abzubrechen.

-- § 11 Abs. 4 Nr. 2 / § 12 Abs. 2-3 GwG: Identifizierungs-Snapshot für
-- juristische Personen und Personengesellschaften direkt am Check.
ALTER TABLE "gwg_check"
  ADD COLUMN "legal_form" TEXT,
  ADD COLUMN "register_number" TEXT,
  ADD COLUMN "register_authority" TEXT,
  ADD COLUMN "no_register_entry" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "representative_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ownership_structure_notes" TEXT;

-- Explizite Herkunft von Onboarding-Dateien + zweiphasiger
-- Vernichtungszustand. Retention kann dadurch auch abgebrochene/abgelehnte
-- Onboardings ohne mandate_ended_at sicher zuordnen.
ALTER TABLE "document"
  ADD COLUMN "gwg_onboarding_invite_id" UUID,
  ADD COLUMN "gwg_destruction_requested_at" TIMESTAMPTZ,
  ADD COLUMN "gwg_destruction_requested_by" UUID,
  ADD COLUMN "gwg_destruction_error" TEXT,
  ADD COLUMN "gwg_destroyed_at" TIMESTAMPTZ;

ALTER TABLE "document"
  ADD CONSTRAINT "document_gwg_invite_fk"
  FOREIGN KEY ("gwg_onboarding_invite_id")
  REFERENCES "gwg_onboarding_invite"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "document_gwg_invite_idx"
  ON "document"("gwg_onboarding_invite_id");

-- gwg_check_id war bislang nur eine lose UUID. Der FK macht die Retention-
-- Zuordnung belastbar; bei Vernichtung des Skeletts bleibt das Invite erhalten.
-- Historische/extern importierte verwaiste IDs werden vor dem Constraint
-- fail-safe entkoppelt, damit das Deployment nicht an Alt-Daten scheitert.
UPDATE "gwg_onboarding_invite" i
SET "gwg_check_id" = NULL
WHERE i."gwg_check_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "gwg_check" gc
     WHERE gc."id" = i."gwg_check_id"
       AND gc."tenant_id" = i."tenant_id"
       AND gc."client_id" = i."client_id"
  );

ALTER TABLE "gwg_onboarding_invite"
  ADD CONSTRAINT "gwg_invite_check_fkey"
  FOREIGN KEY ("gwg_check_id")
  REFERENCES "gwg_check"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- Bestehende Uploads aus der bisherigen JSON-ID-Liste zurückverknüpfen.
UPDATE "document" d
SET "gwg_onboarding_invite_id" = i."id"
FROM "gwg_onboarding_invite" i
WHERE d."tenant_id" = i."tenant_id"
  AND d."client_id" = i."client_id"
  AND d."classification" = 'GWG_EVIDENCE'
  AND jsonb_typeof(i."uploaded_document_ids") = 'array'
  AND i."uploaded_document_ids" ? d."id"::TEXT
  AND d."gwg_onboarding_invite_id" IS NULL;

-- Historische tenant-/mandantenfremde Belegverknüpfungen fail-safe lösen.
UPDATE "gwg_id_document" gid
SET "document_id" = NULL
WHERE gid."document_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM "document" d
      JOIN "gwg_check" gc ON gc."id" = gid."gwg_check_id"
     WHERE d."id" = gid."document_id"
       AND d."tenant_id" = gc."tenant_id"
       AND d."client_id" = gc."client_id"
       AND d."classification" = 'GWG_EVIDENCE'
  );

-- Tenant-/Mandanten-konsistente Relation und irreversibler PENDING-Claim.
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
  ) THEN
    RAISE EXCEPTION 'GwG-ID-Dokument und Check gehören nicht zu demselben Tenant/Mandanten.'
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
CREATE OR REPLACE FUNCTION app.destroy_gwg_check(p_check_id UUID)
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

REVOKE ALL ON FUNCTION app.destroy_gwg_check(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(UUID) TO taxtronik_app;

-- ---------------------------------------------------------------------------
-- Wiederaufnehmbare GwG-Vernichtung.
--
-- document_version ist absichtlich immutable. Nur die SECURITY-DEFINER-
-- Funktion app.destroy_gwg_document_versions darf nach protokollierter
-- Vernichtungsabsicht genau die Versionen eines GWG_EVIDENCE-Dokuments löschen.
-- Die normale UPDATE/DELETE-Sperre bleibt für alle anderen Pfade unverändert.
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
  -- gelockt werden. Der FK-KeyShare käme zu spät und könnte einen INSERT nach
  -- Commit des PENDING-Claims durchlassen. Bei UPDATE werden Quelle und Ziel
  -- sortiert gesperrt, damit auch ein Reparenting den Claim nicht verlässt.
  PERFORM d."id"
    FROM public."document" d
   WHERE d."id" = old_document OR d."id" = new_document
   ORDER BY d."id"
   FOR SHARE;

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
