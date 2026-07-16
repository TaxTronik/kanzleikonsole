-- Eine natürliche Person kann im selben GwG-Snapshot zugleich gesetzlicher
-- Vertreter und wirtschaftlich Berechtigter sein. Die Verknüpfung erfolgt
-- explizit per UUID; gleiche Namen allein sind niemals ein Identitätsbeweis.
BEGIN;

CREATE TYPE "gwg_change_scope" AS ENUM (
  'LEGACY_UNKNOWN',
  'INITIAL',
  'CLIENT_MASTER_DATA',
  'ROUTINE',
  'BENEFICIAL_OWNERS',
  'REPRESENTATIVES',
  'BOTH'
);

ALTER TABLE "gwg_check"
  ADD COLUMN "change_scope" "gwg_change_scope" NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  ADD COLUMN "predecessor_check_id" UUID;

-- Vorhandene Snapshots erhalten durch den ADD-DEFAULT ohne triggerauslösendes
-- UPDATE einen ehrlichen unbekannten Anlass. Nur nach der Migration neu
-- angelegte Prüfungen starten standardmäßig als Erstprüfung.
ALTER TABLE "gwg_check"
  ALTER COLUMN "change_scope" SET DEFAULT 'INITIAL';

CREATE INDEX "gwg_check_predecessor_check_id_idx"
  ON "gwg_check" ("predecessor_check_id");

ALTER TABLE "gwg_check"
  ADD CONSTRAINT "gwg_check_predecessor_fkey"
  FOREIGN KEY ("predecessor_check_id")
  REFERENCES "gwg_check" ("id")
  ON DELETE NO ACTION
  ON UPDATE NO ACTION,
  ADD CONSTRAINT "gwg_check_predecessor_not_self_ck"
  CHECK ("predecessor_check_id" IS NULL OR "predecessor_check_id" <> "id");

ALTER TABLE "gwg_onboarding_invite"
  ADD COLUMN "bound_check_revision" TEXT,
  ADD COLUMN "bound_client_revision" TEXT;

-- Offene Legacy-Links besitzen weder einen belastbaren DRAFT- noch einen
-- Mandanten-Baseline-Hash. Sie werden beim Upgrade fail-closed entwertet,
-- terminale Historienzeilen dürfen ihre null-Revisionsfelder behalten.
-- BEGIN OPEN INVITE REVISION CUTOVER
-- Ein abgelaufener offener Invite kann bereits einen legitimen, irreversiblen
-- Vernichtungsclaim tragen. Der 044-Guard friert dann auch den Invite-Status
-- ein. Fuer den einmaligen Revisions-Cutover autorisiert deshalb ausschliesslich
-- eine nicht oeffentlich ausfuehrbare SECURITY-DEFINER-Funktion genau den
-- PENDING/STARTED -> CANCELLED-Uebergang. Der GUC ist an die konkrete Invite-ID
-- gebunden; alle anderen Felder bleiben unveraendert. Nach dem Cutover wird die
-- Autorisierungsfunktion geloescht, sodass der Guard wieder strikt fail-closed
-- ist. Der ACCESS-EXCLUSIVE-Lock serialisiert gleichzeitig neue Dokumentclaims.
CREATE OR REPLACE FUNCTION app.guard_gwg_invite_check_scope_and_claim()
RETURNS TRIGGER AS $$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
  authorized_revision_cutover BOOLEAN := FALSE;
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
    RAISE EXCEPTION 'GwG-Check gehoert nicht zu Tenant und Mandant der Einladung.'
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

  IF TG_OP = 'UPDATE' THEN
    authorized_revision_cutover := COALESCE((
      current_setting('app.gwg_invite_revision_cutover_id', TRUE) = OLD."id"::TEXT
      AND CURRENT_USER = (
        SELECT pg_get_userbyid(p.proowner)
          FROM pg_catalog.pg_proc p
         WHERE p.oid = pg_catalog.to_regprocedure(
           'app.cancel_legacy_gwg_invites_for_revision_cutover()'
         )
      )
      AND OLD."status" IN ('PENDING', 'STARTED')
      AND NEW."status" = 'CANCELLED'
      AND NEW."cancelled_at" IS NOT DISTINCT FROM
          COALESCE(OLD."cancelled_at", CURRENT_TIMESTAMP::TIMESTAMP(3))
      AND NEW."cancelled_by_staff" IS NULL
      AND NEW."token_hash" = ''
      AND (to_jsonb(NEW)
           - 'status' - 'cancelled_at' - 'cancelled_by_staff' - 'token_hash')
          IS NOT DISTINCT FROM
          (to_jsonb(OLD)
           - 'status' - 'cancelled_at' - 'cancelled_by_staff' - 'token_hash')
    ), FALSE);
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
  ) AND NOT authorized_revision_cutover THEN
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
    RAISE EXCEPTION 'Invite eines vernichteten GwG-Checks ist bis auf updated_at unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.guard_gwg_invite_check_scope_and_claim()
  SET search_path = pg_catalog, public, app, pg_temp;

CREATE OR REPLACE FUNCTION app.cancel_legacy_gwg_invites_for_revision_cutover()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  invite_record RECORD;
  affected_rows INTEGER;
  cancelled_count INTEGER := 0;
BEGIN
  LOCK TABLE public."gwg_onboarding_invite" IN ACCESS EXCLUSIVE MODE;

  FOR invite_record IN
    SELECT invite."id"
      FROM public."gwg_onboarding_invite" invite
     WHERE invite."status" IN ('PENDING', 'STARTED')
     ORDER BY invite."id"
     FOR UPDATE
  LOOP
    PERFORM set_config(
      'app.gwg_invite_revision_cutover_id',
      invite_record."id"::TEXT,
      TRUE
    );
    UPDATE public."gwg_onboarding_invite"
       SET "status" = 'CANCELLED',
           "cancelled_at" = COALESCE("cancelled_at", CURRENT_TIMESTAMP::TIMESTAMP(3)),
           "cancelled_by_staff" = NULL,
           "token_hash" = ''
     WHERE "id" = invite_record."id"
       AND "status" IN ('PENDING', 'STARTED');
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION 'Legacy-GwG-Invite konnte nicht deterministisch entwertet werden.'
        USING ERRCODE = 'serialization_failure';
    END IF;
    cancelled_count := cancelled_count + 1;
  END LOOP;

  PERFORM set_config('app.gwg_invite_revision_cutover_id', '', TRUE);
  RETURN cancelled_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.gwg_invite_revision_cutover_id', '', TRUE);
  RAISE;
END;
$$;

ALTER FUNCTION app.cancel_legacy_gwg_invites_for_revision_cutover()
  OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app.cancel_legacy_gwg_invites_for_revision_cutover() FROM PUBLIC;

SELECT app.cancel_legacy_gwg_invites_for_revision_cutover();

DROP FUNCTION app.cancel_legacy_gwg_invites_for_revision_cutover();
-- END OPEN INVITE REVISION CUTOVER

ALTER TABLE "gwg_onboarding_invite"
  ADD CONSTRAINT "gwg_invite_open_revision_binding_ck"
  CHECK (
    "status" NOT IN ('PENDING', 'STARTED')
    OR (
      (
        "gwg_check_id" IS NULL
        AND "bound_client_revision" IS NOT NULL
        AND "bound_check_revision" IS NULL
      )
      OR
      (
        "gwg_check_id" IS NOT NULL
        AND "bound_check_revision" IS NOT NULL
        AND "bound_client_revision" IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION app.guard_gwg_check_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  predecessor_tenant UUID;
  predecessor_client UUID;
  predecessor_created_at TIMESTAMP(3);
BEGIN
  IF NEW."predecessor_check_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT predecessor."tenant_id", predecessor."client_id", predecessor."created_at"
    INTO predecessor_tenant, predecessor_client, predecessor_created_at
    FROM public."gwg_check" predecessor
   WHERE predecessor."id" = NEW."predecessor_check_id";

  IF predecessor_tenant IS NULL
     OR predecessor_tenant IS DISTINCT FROM NEW."tenant_id"
     OR predecessor_client IS DISTINCT FROM NEW."client_id"
     OR predecessor_created_at >= NEW."created_at"
  THEN
    RAISE EXCEPTION 'GwG-Vorgänger muss eine ältere Prüfung desselben Mandanten sein.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION app.guard_gwg_check_lineage() OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_check_lineage_guard
BEFORE INSERT OR UPDATE OF "tenant_id", "client_id", "created_at", "predecessor_check_id"
ON public."gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_check_lineage();

-- Anlass und Kante sind Teil des unveränderlichen Prüfsnapshots. Beide
-- werden beim INSERT gesetzt; auch ein noch offener DRAFT darf danach nicht
-- umetikettiert oder in der Historie verschoben werden. Das schließt zugleich
-- die neuen Felder im VERIFIED-Snapshot stärker als der bestehende
-- protect_verified_gwg_legal_snapshot-Guard.
CREATE OR REPLACE FUNCTION app.protect_gwg_check_lineage_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF ROW(
       NEW."tenant_id",
       NEW."client_id",
       NEW."change_scope",
       NEW."predecessor_check_id",
       NEW."created_at"
     )
       IS DISTINCT FROM
     ROW(
       OLD."tenant_id",
       OLD."client_id",
       OLD."change_scope",
       OLD."predecessor_check_id",
       OLD."created_at"
     )
  THEN
    RAISE EXCEPTION 'GwG-Prüfungsscope, Prüfungsanlass und Vorgänger sind nach Anlage unveränderlich.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION app.protect_gwg_check_lineage_snapshot() OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_check_lineage_snapshot_immutable
BEFORE UPDATE OF "tenant_id", "client_id", "change_scope", "predecessor_check_id", "created_at"
ON public."gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.protect_gwg_check_lineage_snapshot();

ALTER TABLE "gwg_representative"
  ADD COLUMN "linked_beneficial_owner_id" UUID;

CREATE UNIQUE INDEX "gwg_representative_owner_identity_uq"
  ON "gwg_representative" ("gwg_check_id", "linked_beneficial_owner_id");

CREATE INDEX "gwg_representative_linked_beneficial_owner_id_idx"
  ON "gwg_representative" ("linked_beneficial_owner_id");

ALTER TABLE "gwg_representative"
  ADD CONSTRAINT "gwg_representative_linked_owner_fk"
  FOREIGN KEY ("linked_beneficial_owner_id")
  REFERENCES "gwg_beneficial_owner" ("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION app.guard_gwg_cross_role_person_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF NEW."linked_beneficial_owner_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public."gwg_beneficial_owner" owner
     WHERE owner."id" = NEW."linked_beneficial_owner_id"
       AND owner."gwg_check_id" = NEW."gwg_check_id"
  ) THEN
    RAISE EXCEPTION 'Verknüpfte Rollenidentität gehört nicht zu diesem GwG-Snapshot.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION app.guard_gwg_cross_role_person_identity() OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_representative_cross_role_identity_guard
BEFORE INSERT OR UPDATE OF "gwg_check_id", "linked_beneficial_owner_id"
ON "gwg_representative"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_cross_role_person_identity();

-- Die Check-Zugehörigkeit ist Teil der stabilen Owner-Snapshotidentität.
-- Würde ein Owner nach einer gültigen Doppelrollen-Verknüpfung in einen
-- anderen Check verschoben, könnte die Relation check-übergreifend werden.
CREATE OR REPLACE FUNCTION app.protect_gwg_beneficial_owner_check_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF NEW."gwg_check_id" IS DISTINCT FROM OLD."gwg_check_id" THEN
    RAISE EXCEPTION 'GwG-Berechtigter kann nicht in einen anderen Prüfsnapshot verschoben werden.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION app.protect_gwg_beneficial_owner_check_scope() OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_beneficial_owner_check_scope_immutable
BEFORE UPDATE OF "gwg_check_id"
ON public."gwg_beneficial_owner"
FOR EACH ROW EXECUTE FUNCTION app.protect_gwg_beneficial_owner_check_scope();

-- Ebenso darf eine Vertreteridentität nicht nachträglich in einen anderen
-- Snapshot verschoben werden. Ohne diese Sperre könnten insbesondere noch
-- nicht mit einem Owner verknüpfte Vertreter samt Ausweiszuordnung wandern.
CREATE OR REPLACE FUNCTION app.protect_gwg_representative_check_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF NEW."gwg_check_id" IS DISTINCT FROM OLD."gwg_check_id" THEN
    RAISE EXCEPTION 'GwG-Vertreter kann nicht in einen anderen Prüfsnapshot verschoben werden.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION app.protect_gwg_representative_check_scope() OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_representative_check_scope_immutable
BEFORE UPDATE OF "gwg_check_id"
ON public."gwg_representative"
FOR EACH ROW EXECUTE FUNCTION app.protect_gwg_representative_check_scope();

-- Eine bestätigte Vertreter-Zuordnung darf nach einer Änderung der Person
-- oder ihrer Rollenidentität nicht weiter als geprüft gelten. Das UPDATE
-- umfasst immer alle Vorder-/Rückseiten desselben Dokumentsets und ist damit
-- mit dem deferred Set-Consistency-Guard kompatibel.
CREATE OR REPLACE FUNCTION app.invalidate_gwg_representative_identity_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
BEGIN
  IF ROW(NEW."full_name", NEW."linked_beneficial_owner_id")
       IS NOT DISTINCT FROM
     ROW(OLD."full_name", OLD."linked_beneficial_owner_id")
  THEN
    RETURN NEW;
  END IF;

  WITH affected_sets AS MATERIALIZED (
    SELECT DISTINCT gid."document_set_id"
      FROM public."gwg_id_document" gid
     WHERE gid."representative_subject_id" = NEW."id"
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

ALTER FUNCTION app.invalidate_gwg_representative_identity_assignment()
  OWNER TO CURRENT_USER;

CREATE TRIGGER gwg_representative_identity_assignment_invalidate
AFTER UPDATE OF "full_name", "linked_beneficial_owner_id"
ON public."gwg_representative"
FOR EACH ROW
EXECUTE FUNCTION app.invalidate_gwg_representative_identity_assignment();

-- Die bestehende BO-Invariante wird für die neue Doppelrolle erweitert: Ein
-- dem Vertreter zugeordneter Ausweis repraesentiert in diesem Fall dieselbe
-- natürliche Person und muss deshalb auch bei BO-Stammdatenänderungen erneut
-- bestätigt werden.
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
        OR gid."representative_subject_id" IN (
          SELECT rep."id"
            FROM public."gwg_representative" rep
           WHERE rep."linked_beneficial_owner_id" = NEW."id"
        )
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

ALTER FUNCTION app.invalidate_gwg_beneficial_owner_identity_assignment()
  OWNER TO CURRENT_USER;

COMMIT;
