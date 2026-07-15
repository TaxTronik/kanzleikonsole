-- =============================================================================

BEGIN;
-- GwG-Identitaetszuordnung: stabile Subjects, persistente Dokumentgruppen und
-- ein fail-closed Gate fuer alle neuen bzw. noch offenen Pruefungen.
--
-- Bereits VERIFIED Bestandschecks bleiben grandfathered. Ihre historischen,
-- nur namensbasierten Ausweiszeilen werden aber NICHT stillschweigend als
-- sichere 1:1-Zuordnung markiert. Sobald ein neuer/offener Check verifiziert
-- werden soll, sind echte FKs und eine explizite Bestaetigung Pflicht.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Stabile Vertreter-Subjects. Homonyme Personen bleiben getrennte Zeilen;
--    die Position bildet die bisherige Array-Reihenfolge ab.
-- -----------------------------------------------------------------------------
CREATE TABLE "gwg_representative" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "gwg_check_id" UUID NOT NULL,
  "full_name" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gwg_representative_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gwg_representative_name_not_blank"
    CHECK (NULLIF(BTRIM("full_name"), '') IS NOT NULL),
  CONSTRAINT "gwg_representative_position_nonnegative"
    CHECK ("position" >= 0),
  CONSTRAINT "gwg_representative_gwg_check_id_position_key"
    UNIQUE ("gwg_check_id", "position"),
  CONSTRAINT "gwg_representative_gwg_check_id_fkey"
    FOREIGN KEY ("gwg_check_id") REFERENCES "gwg_check"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "gwg_representative_gwg_check_id_idx"
  ON "gwg_representative"("gwg_check_id");

INSERT INTO "gwg_representative" (
  "gwg_check_id", "full_name", "position", "created_at", "updated_at"
)
SELECT gc."id",
       BTRIM(entry."name"),
       (entry."ordinality" - 1)::INTEGER,
       gc."created_at",
       CURRENT_TIMESTAMP
  FROM "gwg_check" gc
  JOIN "client" c ON c."id" = gc."client_id"
 CROSS JOIN LATERAL UNNEST(gc."representative_names")
   WITH ORDINALITY AS entry("name", "ordinality")
 WHERE c."kind" IN ('JURPERS', 'PERSGES')
   AND gc."destroyed_at" IS NULL
   AND NULLIF(BTRIM(entry."name"), '') IS NOT NULL;

ALTER TABLE "gwg_representative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gwg_representative" FORCE ROW LEVEL SECURITY;

CREATE POLICY gwg_representative_isolation ON "gwg_representative"
  USING (EXISTS (
    SELECT 1
      FROM "gwg_check" gc
     WHERE gc."id" = "gwg_representative"."gwg_check_id"
       AND gc."tenant_id" = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM "gwg_check" gc
     WHERE gc."id" = "gwg_representative"."gwg_check_id"
       AND gc."tenant_id" = app.current_tenant_id()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON "gwg_representative" TO taxtronik_app;

-- -----------------------------------------------------------------------------
-- 2. Cutover-Flag und persistente Subject-/Set-Felder.
-- -----------------------------------------------------------------------------
ALTER TABLE "gwg_check"
  ADD COLUMN "identity_assignment_required" BOOLEAN NOT NULL DEFAULT TRUE;

-- Ausschliesslich bereits abgeschlossene, noch vorhandene Freigaben duerfen
-- grandfathered sein. Vernichtete Skelette bleiben TRUE; sie sind nur noch
-- Aufbewahrungsnachweis und ihr 034-Guard verbietet jede nachtraegliche
-- Zeilenaenderung. Durch DEFAULT TRUE brauchen offene/vernichtete Checks kein
-- UPDATE und der Cutover bleibt upgrade-sicher.
UPDATE "gwg_check"
   SET "identity_assignment_required" = FALSE
 WHERE "status" = 'VERIFIED'
   AND "destroyed_at" IS NULL;

ALTER TABLE "gwg_check"
  ADD CONSTRAINT "gwg_check_identity_assignment_required_state"
    CHECK ("identity_assignment_required" OR "status" = 'VERIFIED');

ALTER TABLE "gwg_id_document"
  ADD COLUMN "document_set_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "natural_client_subject_id" UUID,
  ADD COLUMN "beneficial_owner_subject_id" UUID,
  ADD COLUMN "representative_subject_id" UUID,
  ADD COLUMN "identity_assignment_confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "identity_assignment_confirmed_by" UUID;

-- Ein konkreter Aktenbeleg darf innerhalb desselben Checks nicht mehrfach in
-- verschiedene Sets geraten. Historische Dubletten werden fail-closed geloest:
-- die aelteste Relation bleibt, alle weiteren Snapshot-Zeilen bleiben erhalten,
-- muessen ihren Beleg aber bewusst neu zugeordnet bekommen.
-- BEGIN VERIFIED LEGACY DUPLICATE REMEDIATION
-- 034 friert Ausweiszeilen verifizierter Checks ein. Nur fuer diese
-- deterministische Backfill-Korrektur wird der konkrete Guard unter dem durch
-- ALTER TABLE gehaltenen Lock deaktiviert und sein vorheriger Modus gemerkt.
DO $$
DECLARE
  previous_mode "char";
BEGIN
  SELECT t.tgenabled
    INTO previous_mode
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.gwg_id_document'::regclass
     AND t.tgname = 'gwg_id_document_scope_and_claim'
     AND NOT t.tgisinternal;

  IF previous_mode IS NOT NULL AND previous_mode <> 'D' THEN
    PERFORM set_config('app.gwg_043_scope_trigger_mode', previous_mode::TEXT, TRUE);
    EXECUTE 'ALTER TABLE public."gwg_id_document" DISABLE TRIGGER gwg_id_document_scope_and_claim';
  END IF;
END;
$$;

WITH ranked AS MATERIALIZED (
  SELECT gid."id",
         ROW_NUMBER() OVER (
           PARTITION BY gid."gwg_check_id", gid."document_id"
           ORDER BY gid."created_at", gid."id"
         ) AS rn
    FROM "gwg_id_document" gid
   WHERE gid."document_id" IS NOT NULL
)
UPDATE "gwg_id_document" gid
   SET "document_id" = NULL
  FROM ranked r
 WHERE gid."id" = r."id"
   AND r.rn > 1;

DO $$
DECLARE
  previous_mode TEXT := current_setting('app.gwg_043_scope_trigger_mode', TRUE);
BEGIN
  IF previous_mode = 'O' THEN
    EXECUTE 'ALTER TABLE public."gwg_id_document" ENABLE TRIGGER gwg_id_document_scope_and_claim';
  ELSIF previous_mode = 'A' THEN
    EXECUTE 'ALTER TABLE public."gwg_id_document" ENABLE ALWAYS TRIGGER gwg_id_document_scope_and_claim';
  ELSIF previous_mode = 'R' THEN
    EXECUTE 'ALTER TABLE public."gwg_id_document" ENABLE REPLICA TRIGGER gwg_id_document_scope_and_claim';
  END IF;
END;
$$;
-- END VERIFIED LEGACY DUPLICATE REMEDIATION

ALTER TABLE "gwg_id_document"
  ADD CONSTRAINT "gwg_id_document_gwg_check_id_document_id_key"
    UNIQUE ("gwg_check_id", "document_id"),
  ADD CONSTRAINT "gwg_id_document_natural_client_subject_id_fkey"
    FOREIGN KEY ("natural_client_subject_id") REFERENCES "client"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "gwg_id_document_beneficial_owner_subject_id_fkey"
    FOREIGN KEY ("beneficial_owner_subject_id") REFERENCES "gwg_beneficial_owner"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "gwg_id_document_representative_subject_id_fkey"
    FOREIGN KEY ("representative_subject_id") REFERENCES "gwg_representative"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "gwg_id_document_identity_subject_count"
    CHECK (num_nonnulls(
      "natural_client_subject_id",
      "beneficial_owner_subject_id",
      "representative_subject_id"
    ) <= 1),
  ADD CONSTRAINT "gwg_id_document_identity_subject_personal_type"
    CHECK (
      num_nonnulls(
        "natural_client_subject_id",
        "beneficial_owner_subject_id",
        "representative_subject_id"
      ) = 0
      OR "type" IN ('PERSONALAUSWEIS', 'REISEPASS')
    ),
  ADD CONSTRAINT "gwg_id_document_identity_confirmation_complete"
    CHECK (
      (
        "identity_assignment_confirmed_at" IS NULL
        AND "identity_assignment_confirmed_by" IS NULL
      )
      OR (
        "identity_assignment_confirmed_at" IS NOT NULL
        AND "identity_assignment_confirmed_by" IS NOT NULL
        AND num_nonnulls(
          "natural_client_subject_id",
          "beneficial_owner_subject_id",
          "representative_subject_id"
        ) = 1
        AND "type" IN ('PERSONALAUSWEIS', 'REISEPASS')
      )
    );

CREATE INDEX "gwg_id_document_gwg_check_id_document_set_id_idx"
  ON "gwg_id_document"("gwg_check_id", "document_set_id");
CREATE INDEX "gwg_id_document_natural_client_subject_id_idx"
  ON "gwg_id_document"("natural_client_subject_id");
CREATE INDEX "gwg_id_document_beneficial_owner_subject_id_idx"
  ON "gwg_id_document"("beneficial_owner_subject_id");
CREATE INDEX "gwg_id_document_representative_subject_id_idx"
  ON "gwg_id_document"("representative_subject_id");

-- -----------------------------------------------------------------------------
-- 3. Scope-/Bestaetigungs-Guard. owner_name bleibt nur Anzeigesnapshot und darf
--    eine echte FK-Zuordnung niemals ersetzen.
-- -----------------------------------------------------------------------------
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

CREATE TRIGGER gwg_id_document_subject_and_set_guard
BEFORE INSERT OR UPDATE ON "gwg_id_document"
FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_subject_and_set();

-- Innerhalb eines Sets muessen Check, Ausweistyp und Person identisch sein.
-- Deferred erlaubt ein atomisches updateMany fuer Vorder- und Rueckseite.
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

CREATE CONSTRAINT TRIGGER gwg_document_set_consistency
AFTER INSERT OR UPDATE ON "gwg_id_document"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_gwg_document_set_consistency();

-- -----------------------------------------------------------------------------
-- 4. Vertreter sind Teil des unveraenderlichen GwG-Snapshots.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.protect_verified_gwg_representative()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  old_check_id UUID;
  new_check_id UUID;
  new_check_kind public."client_kind";
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

  PERFORM gc."id"
    FROM public."gwg_check" gc
   WHERE gc."id" = old_check_id OR gc."id" = new_check_id
   ORDER BY gc."id"
   FOR SHARE;

  IF EXISTS (
    SELECT 1
      FROM public."gwg_check" gc
     WHERE gc."id" IN (old_check_id, new_check_id)
       AND EXISTS (
         SELECT 1 FROM public."tenant" t WHERE t."id" = gc."tenant_id"
       )
       AND (
         gc."verified_at" IS NOT NULL
         OR gc."status" = 'VERIFIED'
         OR gc."destroyed_at" IS NOT NULL
       )
  ) AND NOT authorized_check_destruction THEN
    RAISE EXCEPTION 'Einmal verifizierter GwG-Vertreter-Snapshot ist unveraenderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT c."kind" INTO new_check_kind
      FROM public."gwg_check" gc
      JOIN public."client" c ON c."id" = gc."client_id"
     WHERE gc."id" = NEW."gwg_check_id";
    IF new_check_kind NOT IN ('JURPERS', 'PERSGES') THEN
      RAISE EXCEPTION 'Vertreter-Subjects sind nur fuer juristische Personen und Personengesellschaften zulaessig.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER gwg_representative_verified_snapshot_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "gwg_representative"
FOR EACH ROW EXECUTE FUNCTION app.protect_verified_gwg_representative();

-- Die vorhandene SECURITY-DEFINER-Vernichtung anonymisiert owner_name. Der
-- Subject-Guard nullt dabei alle neuen Identitaetsfelder. Anschliessend werden
-- auch die stabilen Vertreter-Snapshots innerhalb derselben Capability geloescht.
CREATE OR REPLACE FUNCTION app.purge_gwg_representatives_after_destruction()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  authorized_check_destruction BOOLEAN;
BEGIN
  authorized_check_destruction := COALESCE((
    current_setting('app.gwg_destroy_check_id', TRUE) = OLD."id"::TEXT
    AND CURRENT_USER = (
      SELECT pg_get_userbyid(p.proowner)
        FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)')
    )
  ), FALSE);

  IF NOT authorized_check_destruction THEN
    RAISE EXCEPTION 'GwG-Vertreter duerfen nur kontrolliert vernichtet werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  DELETE FROM public."gwg_representative"
   WHERE "gwg_check_id" = NEW."id";
  RETURN NEW;
END;
$$;

CREATE TRIGGER gwg_check_purge_representatives_after_destruction
AFTER UPDATE OF "destroyed_at" ON "gwg_check"
FOR EACH ROW
WHEN (OLD."destroyed_at" IS NULL AND NEW."destroyed_at" IS NOT NULL)
EXECUTE FUNCTION app.purge_gwg_representatives_after_destruction();

-- -----------------------------------------------------------------------------
-- 5. Exaktes Identity-Gate fuer neue/offene Checks.
-- -----------------------------------------------------------------------------
-- Identitaetsrelevante Aenderungen an wirtschaftlich Berechtigten machen eine
-- zuvor bestaetigte Ausweiszuordnung fachlich ungueltig. Alle Dateien desselben
-- Ausweissatzes werden gemeinsam invalidiert; nichts bleibt halb-bestaetigt.
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

CREATE TRIGGER "00_gwg_check_identity_verification_guard"
BEFORE INSERT OR UPDATE OF "status", "verified_at", "identity_assignment_required"
ON "gwg_check"
FOR EACH ROW EXECUTE FUNCTION app.enforce_gwg_identity_assignment_on_verification();

-- Defense in Depth fuer client.allow_active: grandfathered VERIFIED bleibt
-- gueltig; jeder required Check muss das neue Identity-Gate weiterhin erfuellen.
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

COMMIT;
