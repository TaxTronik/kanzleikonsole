-- Forward-only convergence for databases that applied one of the three
-- released checksum variants of migration 20260809000000. That migration is
-- frozen at checksum 028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74;
-- all compatibility work happens here instead of mutating history again.
--
-- The business repair is deliberately replayed in full and remains idempotent.
-- Unknown ledger drift is attested and rejected before any checksum is changed.

BEGIN;

-- Canonical definition: app.block_version_during_gwg_destruction()
CREATE OR REPLACE FUNCTION app.block_version_during_gwg_destruction()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$
;

-- Canonical definition: app.guard_gwg_document_invite_and_claim()
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
$function$
;

-- Canonical definition: app.guard_gwg_id_document_scope_and_claim()
CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_scope_and_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$
;

-- Canonical definition: app.guard_gwg_id_document_subject_and_set()
CREATE OR REPLACE FUNCTION app.guard_gwg_id_document_subject_and_set()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$
;

-- Canonical definition: app.gwg_check_has_confirmed_identity(p_check_id uuid)
CREATE OR REPLACE FUNCTION app.gwg_check_has_confirmed_identity(p_check_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$
;

-- Canonical definition: app.invalidate_gwg_beneficial_owner_identity_assignment()
CREATE OR REPLACE FUNCTION app.invalidate_gwg_beneficial_owner_identity_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$
;

-- Canonical definition: app.poa_protect_integrity()
CREATE OR REPLACE FUNCTION app.poa_protect_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  snapshot_json JSONB;
  version_sha256 BYTEA;
  validate_snapshot BOOLEAN := FALSE;
  entering_signed BOOLEAN := FALSE;
  retention_anonymization BOOLEAN := FALSE;
  retention_closed BOOLEAN := FALSE;
  validate_client_scope BOOLEAN := FALSE;
BEGIN
  -- Lock and validate the concrete client row before any INSERT can reach the
  -- later FK trigger. This serializes PoA creation with final retention and
  -- also enforces the tenant/client pair missing from the legacy FK layout.
  validate_client_scope := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    validate_client_scope :=
      NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
      OR NEW."client_id" IS DISTINCT FROM OLD."client_id";
  END IF;

  IF validate_client_scope THEN
    SELECT (
      c."mandate_ended_at" IS NOT NULL
      AND make_date(
            EXTRACT(YEAR FROM c."mandate_ended_at")::INTEGER + 11,
            1,
            1
          ) <= CURRENT_DATE
      AND (
        (c."kind" = 'NATPERS' AND c."anonymized_at" IS NOT NULL) OR
        (
          c."kind" IN ('JURPERS', 'PERSGES')
          AND c."poa_signer_data_redacted_at" IS NOT NULL
        )
      )
    )
      INTO retention_closed
      FROM public."client" c
     WHERE c."id" = NEW."client_id"
       AND c."tenant_id" = NEW."tenant_id"
     FOR UPDATE OF c;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PoA-Mandant gehört nicht zum angegebenen Tenant.'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF retention_closed THEN
      RAISE EXCEPTION 'PoA-Neuanlage/-zuordnung ist nach abgeschlossener Signer-Retention nicht zulässig.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id" OR
    NEW."created_by_staff" IS DISTINCT FROM OLD."created_by_staff" OR
    NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'PoA-Erstellungsprovenienz ist unveränderlich.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- SENT/SIGNED are evidence-bearing workflow states and may only arise via
    -- the controlled transitions below.
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Neue PoA muss im Status DRAFT angelegt werden.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."sent_at" IS NOT NULL
       OR NEW."signed_by_ip" IS NOT NULL
       OR NEW."signed_by_user_agent" IS NOT NULL
       OR NEW."revoked_at" IS NOT NULL
       OR NEW."revoked_reason" IS NOT NULL THEN
      RAISE EXCEPTION 'Neue PoA im Status DRAFT darf noch keine Versand-, Signatur- oder Widerrufsprovenienz tragen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signing_content_sha256" IS NOT NULL
       AND octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_content_sha256" IS NOT NULL
       AND octet_length(NEW."signed_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    validate_snapshot := NEW."signing_content_snapshot" IS NOT NULL;
    entering_signed := FALSE;
  ELSE
    -- Vollständige Vorwärtsmatrix; insbesondere REVOKED und EXPIRED sind
    -- terminal. Statusgleiche Updates bleiben für OTP, Revoke-Metadaten und
    -- DSGVO-Anonymisierung möglich.
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'DRAFT'  AND NEW."status" IN ('SENT', 'REVOKED', 'EXPIRED')) OR
      (OLD."status" = 'SENT'   AND NEW."status" IN ('SIGNED', 'REVOKED', 'EXPIRED')) OR
      (OLD."status" = 'SIGNED' AND NEW."status" IN ('REVOKED', 'EXPIRED'))
    ) THEN
      RAISE EXCEPTION 'PoA-Statuswechsel % -> % ist nicht zulässig.', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Der erste belastbare Versandzeitpunkt stammt ausschließlich von der DB.
    -- Das gilt auch für einen Legacy-SENT-Datensatz, der durch einen separaten
    -- Resend erstmals einen Inhalts-Snapshot erhält. Danach ist der Zeitpunkt
    -- unveränderlich und kann nicht für eine Rückdatierung missbraucht werden.
    IF OLD."sent_at" IS NULL AND (
      (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
      (
        OLD."status" = 'SENT' AND NEW."status" = 'SENT'
        AND OLD."signing_content_snapshot" IS NULL
        AND NEW."signing_content_snapshot" IS NOT NULL
      )
    ) THEN
      -- created_at is legacy TIMESTAMP(3). Round the later statement timestamp
      -- to the same precision so a fast transition cannot appear earlier due
      -- solely to different rounding. Do not clamp to created_at: an invalid,
      -- future creation time must still fail poa_sent_at_after_created_check.
      NEW."sent_at" := statement_timestamp()::TIMESTAMPTZ(3);
    ELSIF NEW."sent_at" IS DISTINCT FROM OLD."sent_at" THEN
      RAISE EXCEPTION 'PoA-Versandzeitpunkt ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Einziger zulässiger Redaktionspfad für die sonst immutable Beweiskopie:
    -- NATPERS wurde nachweislich anonymisiert bzw. für JURPERS/PERSGES wurde
    -- der eigene PoA-Signer-Retentionlauf markiert UND die 10-Jahres-Frist ab
    -- Mandatsende-Jahresende ist abgelaufen.
    -- Das exakte Zielmuster verhindert, dass dieser Pfad als allgemeines
    -- Immutability-Bypass missbraucht wird.
    SELECT (
      EXISTS (
        SELECT 1
          FROM public."client" c
         WHERE c."id" = NEW."client_id"
           AND c."tenant_id" = NEW."tenant_id"
           AND c."mandate_ended_at" IS NOT NULL
           AND make_date(
                 EXTRACT(YEAR FROM c."mandate_ended_at")::INTEGER + 11,
                 1,
                 1
               ) <= CURRENT_DATE
           AND (
             (c."kind" = 'NATPERS' AND c."anonymized_at" IS NOT NULL) OR
             (
               c."kind" IN ('JURPERS', 'PERSGES')
               AND c."poa_signer_data_redacted_at" IS NOT NULL
             )
           )
      )
      -- Nur die fest definierte Redaktion darf von der Beweis-Immutability
      -- abweichen. Alle Identitäts-, Status-, Frist- und Auditfelder bleiben
      -- dabei unverändert; updated_at darf Prisma erwartungsgemäß fortschreiben.
      AND NEW."id" IS NOT DISTINCT FROM OLD."id"
      AND NEW."tenant_id" IS NOT DISTINCT FROM OLD."tenant_id"
      AND NEW."client_id" IS NOT DISTINCT FROM OLD."client_id"
      AND NEW."valid_from" IS NOT DISTINCT FROM OLD."valid_from"
      AND NEW."valid_until" IS NOT DISTINCT FROM OLD."valid_until"
      AND NEW."status" IS NOT DISTINCT FROM OLD."status"
      AND NEW."created_by_staff" IS NOT DISTINCT FROM OLD."created_by_staff"
      AND NEW."sent_at" IS NOT DISTINCT FROM OLD."sent_at"
      AND NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at"
      AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
      AND NEW."signer_contact_id" IS NULL
      AND NEW."signer_name" = 'Anonymisiert'
      AND NEW."signer_email"::TEXT = 'anonymisiert@taxtronik.local'
      AND NEW."subject" = 'Anonymisiert'
      AND NEW."scope" = 'Anonymisiert'
      AND NEW."signing_token_hash" IS NULL
      AND NEW."signing_token_expires_at" IS NULL
      AND NEW."signing_otp_hash" IS NULL
      AND NEW."signing_otp_expires_at" IS NULL
      AND NEW."signing_otp_attempts" = 0
      AND NEW."signing_otp_attempts_total" = 0
      AND NEW."signing_content_snapshot" IS NULL
      AND NEW."signing_content_sha256" IS NULL
      AND NEW."signing_document_version_id" IS NULL
      AND NEW."signed_at" IS NULL
      AND NEW."signed_content_sha256" IS NULL
      AND NEW."signed_document_version_id" IS NULL
      AND NEW."signed_by_ip" IS NULL
      AND NEW."signed_by_user_agent" IS NULL
      AND NEW."document_id" IS NULL
      AND NEW."revoked_reason" IS NULL
    ) INTO retention_anonymization;

    -- Die fachlichen Inhalts- und Unterzeichnerfelder sind ab dem ersten
    -- Verlassen von DRAFT festgeschrieben. Nur die oben exakt eingegrenzte
    -- DSGVO-Retention darf sie nach Fristablauf redigieren.
    IF NOT retention_anonymization AND OLD."status" <> 'DRAFT' AND (
      NEW."signer_contact_id" IS DISTINCT FROM OLD."signer_contact_id" OR
      NEW."signer_name" IS DISTINCT FROM OLD."signer_name" OR
      NEW."signer_email" IS DISTINCT FROM OLD."signer_email" OR
      NEW."subject" IS DISTINCT FROM OLD."subject" OR
      NEW."scope" IS DISTINCT FROM OLD."scope" OR
      NEW."valid_from" IS DISTINCT FROM OLD."valid_from" OR
      NEW."valid_until" IS DISTINCT FROM OLD."valid_until" OR
      NEW."document_id" IS DISTINCT FROM OLD."document_id" OR
      NEW."client_id" IS DISTINCT FROM OLD."client_id" OR
      NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    ) THEN
      RAISE EXCEPTION 'PoA-Inhaltsfelder sind nach dem ersten Versand unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Ein vorhandener Versand-Snapshot ist append-only. Ein Resend schreibt
    -- dieselben Werte erneut und bleibt damit erlaubt.
    IF NOT retention_anonymization AND OLD."signing_content_snapshot" IS NOT NULL AND (
      NEW."signing_content_snapshot" IS DISTINCT FROM OLD."signing_content_snapshot" OR
      NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256" OR
      NEW."signing_document_version_id" IS DISTINCT FROM OLD."signing_document_version_id"
    ) THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist nach dem ersten Versand unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Legacy-SENT darf durch einen statusgleichen Resend einmalig einen
    -- Snapshot erhalten. Retroaktive Bindung einer bereits SIGNED/terminalen
    -- Zeile oder Bindung erst im selben SENT->SIGNED-Statement ist unzulässig.
    IF NOT retention_anonymization
       AND OLD."signing_content_snapshot" IS NULL
       AND NEW."signing_content_snapshot" IS NOT NULL
       AND NOT (
         (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
         (OLD."status" = 'SENT' AND NEW."status" = 'SENT')
       ) THEN
      RAISE EXCEPTION 'PoA-Legacy-Datensatz muss vor der Signatur separat neu versendet werden.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Nach dem Signaturakt bleiben Hash, Version, Zeitpunkt und die technisch
    -- erhobenen Herkunftsindizien auch bei REVOKED/EXPIRED unveränderlich.
    -- Legacy-SIGNED ohne diese Felder bleibt migrationsfähig, darf sie aber
    -- nicht nachträglich setzen.
    IF NOT retention_anonymization AND (
      OLD."status" = 'SIGNED' OR
      OLD."signed_at" IS NOT NULL OR
      OLD."signed_content_sha256" IS NOT NULL OR
      OLD."signed_document_version_id" IS NOT NULL OR
      OLD."signed_by_ip" IS NOT NULL OR
      OLD."signed_by_user_agent" IS NOT NULL
    ) AND (
      NEW."signed_at" IS DISTINCT FROM OLD."signed_at" OR
      NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256" OR
      NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id" OR
      NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip" OR
      NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent"
    ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256"
       AND NEW."signing_content_sha256" IS NOT NULL
       AND octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256"
       AND NEW."signed_content_sha256" IS NOT NULL
       AND octet_length(NEW."signed_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;

    validate_snapshot :=
      NEW."signing_content_snapshot" IS DISTINCT FROM OLD."signing_content_snapshot" OR
      NEW."signing_content_sha256" IS DISTINCT FROM OLD."signing_content_sha256" OR
      NEW."signing_document_version_id" IS DISTINCT FROM OLD."signing_document_version_id" OR
      (OLD."status" = 'DRAFT' AND NEW."status" = 'SENT') OR
      (OLD."status" = 'SENT' AND NEW."status" = 'SIGNED');
    entering_signed := OLD."status" = 'SENT' AND NEW."status" = 'SIGNED';

    -- Signed-Evidence darf bei UPDATE ausschließlich atomar im echten
    -- SENT->SIGNED-Übergang entstehen. Statusgleiche bzw. terminale Zeilen
    -- dürfen es weder vorbefüllen noch nachtragen; die kontrollierte
    -- Retention darf es nach Fristablauf ausschließlich löschen.
    IF NOT retention_anonymization
       AND (
         NEW."signed_at" IS DISTINCT FROM OLD."signed_at" OR
         NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256" OR
         NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id" OR
         NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip" OR
         NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent"
       )
       AND NOT (
         OLD."status" = 'SENT'
         AND NEW."status" = 'SIGNED'
         AND OLD."signed_at" IS NULL
         AND OLD."signed_content_sha256" IS NULL
         AND OLD."signed_document_version_id" IS NULL
         AND OLD."signed_by_ip" IS NULL
         AND OLD."signed_by_user_agent" IS NULL
       ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf nur atomar beim Übergang zu SIGNED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Signed-Evidence darf niemals auf DRAFT/SENT vorbefüllt werden. Für einen
  -- migrationssicheren Legacy-Datensatz greift das Verbot nur bei INSERT,
  -- Statuswechsel oder tatsächlicher Änderung eines Signed-Feldes.
  IF TG_OP = 'INSERT' AND NEW."status" <> 'SIGNED' AND (
    NEW."signed_at" IS NOT NULL OR
    NEW."signed_content_sha256" IS NOT NULL OR
    NEW."signed_document_version_id" IS NOT NULL OR
    NEW."signed_by_ip" IS NOT NULL OR
    NEW."signed_by_user_agent" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PoA-Signaturnachweis darf nur mit Status SIGNED angelegt werden.'
      USING ERRCODE = 'check_violation';
  ELSIF NEW."status" IN ('DRAFT', 'SENT') AND (
    NEW."signed_at" IS NOT NULL OR
    NEW."signed_content_sha256" IS NOT NULL OR
    NEW."signed_document_version_id" IS NOT NULL OR
    NEW."signed_by_ip" IS NOT NULL OR
    NEW."signed_by_user_agent" IS NOT NULL
  ) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf vor SIGNED nicht gesetzt werden.'
        USING ERRCODE = 'check_violation';
    ELSIF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."signed_at" IS DISTINCT FROM OLD."signed_at"
       OR NEW."signed_content_sha256" IS DISTINCT FROM OLD."signed_content_sha256"
       OR NEW."signed_document_version_id" IS DISTINCT FROM OLD."signed_document_version_id"
       OR NEW."signed_by_ip" IS DISTINCT FROM OLD."signed_by_ip"
       OR NEW."signed_by_user_agent" IS DISTINCT FROM OLD."signed_by_user_agent" THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis darf vor SIGNED nicht gesetzt werden.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF retention_anonymization THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'REVOKED' AND (
      NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR
      NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
    ) THEN
      RAISE EXCEPTION 'PoA-Widerrufsnachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."status" = 'REVOKED' AND OLD."status" <> 'REVOKED' THEN
      IF OLD."revoked_at" IS NOT NULL OR OLD."revoked_reason" IS NOT NULL
         OR NEW."revoked_at" IS NULL
         OR NULLIF(BTRIM(NEW."revoked_reason"), '') IS NULL THEN
        RAISE EXCEPTION 'PoA-Widerruf erfordert atomar Zeitpunkt und Begründung.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW."revoked_at" < NEW."created_at"
         OR (NEW."sent_at" IS NOT NULL AND NEW."revoked_at" < NEW."sent_at")
         OR (NEW."signed_at" IS NOT NULL AND NEW."revoked_at" < NEW."signed_at")
         OR NEW."revoked_at" < statement_timestamp() - INTERVAL '5 minutes'
         OR NEW."revoked_at" > statement_timestamp() + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'PoA-Widerrufszeitpunkt ist unplausibel.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."status" <> 'REVOKED' AND (
      NEW."revoked_at" IS NOT NULL OR NEW."revoked_reason" IS NOT NULL
    ) AND (
      NEW."status" IS DISTINCT FROM OLD."status" OR
      NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR
      NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason"
    ) THEN
      RAISE EXCEPTION 'PoA-Widerrufsnachweis darf nur beim Übergang zu REVOKED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'DRAFT' AND (
    NEW."signing_content_snapshot" IS NOT NULL OR
    NEW."signing_content_sha256" IS NOT NULL OR
    NEW."signing_document_version_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PoA-DRAFT darf noch keinen Versand-Snapshot tragen.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF validate_snapshot THEN
    IF NEW."signing_content_snapshot" IS NULL OR NEW."signing_content_sha256" IS NULL THEN
      RAISE EXCEPTION 'PoA-Versand erfordert Snapshot und SHA-256.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF octet_length(NEW."signing_content_sha256") <> 32 THEN
      RAISE EXCEPTION 'PoA-Versandhash muss genau 32 Byte (SHA-256) lang sein.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF digest(convert_to(NEW."signing_content_snapshot", 'UTF8'), 'sha256')
       <> NEW."signing_content_sha256" THEN
      RAISE EXCEPTION 'PoA-Versandhash stimmt nicht mit dem Snapshot überein.'
        USING ERRCODE = 'check_violation';
    END IF;

    BEGIN
      snapshot_json := NEW."signing_content_snapshot"::JSONB;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist kein gültiges JSON.'
        USING ERRCODE = 'check_violation';
    END;

    IF jsonb_typeof(snapshot_json) <> 'object' THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist unvollständig oder passt nicht zu den Inhaltsfeldern.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF (SELECT COUNT(*) FROM jsonb_object_keys(snapshot_json)) <> 8
       OR NOT snapshot_json ?& ARRAY[
         'schemaVersion', 'subject', 'signerName', 'signerEmail',
         'validFrom', 'validUntil', 'scope', 'document'
       ]
       OR COALESCE(jsonb_typeof(snapshot_json->'schemaVersion'), 'missing') <> 'number'
       OR snapshot_json->'schemaVersion' <> '1'::JSONB
       OR COALESCE(jsonb_typeof(snapshot_json->'subject'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'signerName'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'signerEmail'), 'missing') <> 'string'
       OR COALESCE(jsonb_typeof(snapshot_json->'validFrom'), 'missing') <> 'string'
       OR NOT (snapshot_json ? 'validUntil')
       OR COALESCE(jsonb_typeof(snapshot_json->'validUntil'), 'missing') NOT IN ('string', 'null')
       OR snapshot_json->>'subject' <> NEW."subject"
       OR snapshot_json->>'signerName' <> NEW."signer_name"
       OR snapshot_json->>'signerEmail' <> NEW."signer_email"::TEXT
       OR snapshot_json->>'validFrom' <> to_char(NEW."valid_from", 'YYYY-MM-DD')
       OR (
         NEW."valid_until" IS NULL
         AND jsonb_typeof(snapshot_json->'validUntil') <> 'null'
       )
       OR (
         NEW."valid_until" IS NOT NULL
         AND (
           jsonb_typeof(snapshot_json->'validUntil') <> 'string'
           OR snapshot_json->>'validUntil' <> to_char(NEW."valid_until", 'YYYY-MM-DD')
         )
       ) THEN
      RAISE EXCEPTION 'PoA-Versand-Snapshot ist unvollständig oder passt nicht zu den Inhaltsfeldern.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."document_id" IS NULL THEN
      IF NEW."signing_document_version_id" IS NOT NULL
         OR COALESCE(jsonb_typeof(snapshot_json->'document'), 'missing') <> 'null'
         OR COALESCE(jsonb_typeof(snapshot_json->'scope'), 'missing') <> 'string'
         OR snapshot_json->>'scope' <> NEW."scope" THEN
        RAISE EXCEPTION 'PoA-Text-Snapshot muss exakt den Vollmachtstext enthalten.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW."signing_document_version_id" IS NULL
         OR COALESCE(jsonb_typeof(snapshot_json->'document'), 'missing') <> 'object'
         OR (CASE
              WHEN jsonb_typeof(snapshot_json->'document') = 'object'
              THEN (SELECT COUNT(*) FROM jsonb_object_keys(snapshot_json->'document'))
              ELSE -1
            END) <> 3
         OR NOT ((snapshot_json->'document') ?& ARRAY['documentId', 'versionId', 'sha256'])
         OR COALESCE(jsonb_typeof(snapshot_json->'scope'), 'missing') <> 'null'
         OR snapshot_json#>>'{document,documentId}' <> NEW."document_id"::TEXT
         OR snapshot_json#>>'{document,versionId}' <> NEW."signing_document_version_id"::TEXT
         OR COALESCE(snapshot_json#>>'{document,sha256}', '') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'PoA-Dokument-Snapshot ist unvollständig oder verweist auf eine andere Version.'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT dv."sha256" INTO version_sha256
        FROM public."document_version" dv
       WHERE dv."id" = NEW."signing_document_version_id"
         AND dv."document_id" = NEW."document_id";
      IF NOT FOUND
         OR encode(version_sha256, 'hex') <> snapshot_json#>>'{document,sha256}' THEN
        RAISE EXCEPTION 'PoA-Dokumentversion oder Dokumenthash stimmt nicht mit dem Snapshot überein.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF entering_signed THEN
    -- Legacy-SENT ohne Snapshot darf nicht Snapshot und Signatur in einem
    -- Schritt nachholen; zuerst ist ein separater Resend erforderlich.
    IF TG_OP = 'UPDATE' AND OLD."signing_content_snapshot" IS NULL THEN
      RAISE EXCEPTION 'PoA-Legacy-SENT muss vor der Signatur neu versendet werden.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      OLD."signed_at" IS NOT NULL OR
      OLD."signed_content_sha256" IS NOT NULL OR
      OLD."signed_document_version_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'PoA-Signaturnachweis muss atomar beim Übergang zu SIGNED entstehen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_at" IS NULL OR NEW."signed_content_sha256" IS NULL THEN
      RAISE EXCEPTION 'PoA-SIGNED erfordert Zeitpunkt und signierten SHA-256.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."sent_at" IS NULL
       OR NEW."signed_at" < NEW."sent_at"
       OR NEW."signed_at" < NEW."created_at"
       OR NEW."signed_at" < statement_timestamp() - INTERVAL '5 minutes'
       OR NEW."signed_at" > statement_timestamp() + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION 'PoA-Signaturzeitpunkt liegt nicht plausibel nach dem Versand.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF octet_length(NEW."signed_content_sha256") <> 32
       OR NEW."signed_content_sha256" <> NEW."signing_content_sha256" THEN
      RAISE EXCEPTION 'PoA-Signaturhash muss dem Versandhash entsprechen.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."signed_document_version_id"
       IS DISTINCT FROM NEW."signing_document_version_id" THEN
      RAISE EXCEPTION 'PoA-signierte Dokumentversion muss der Versandversion entsprechen.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

-- Canonical definition: app.protect_dsgvo_terminal_evidence()
CREATE OR REPLACE FUNCTION app.protect_dsgvo_terminal_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW."result_document_id" IS DISTINCT FROM OLD."result_document_id"
       OR NEW."result_sha256" IS DISTINCT FROM OLD."result_sha256"
     )
     AND NEW."result_reviewed_at" IS NOT DISTINCT FROM OLD."result_reviewed_at"
     AND NEW."result_reviewed_by" IS NOT DISTINCT FROM OLD."result_reviewed_by" THEN
    NEW."result_reviewed_at" := NULL;
    NEW."result_reviewed_by" := NULL;
  END IF;

  IF NEW."result_document_id" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "document" d
       WHERE d."id" = NEW."result_document_id"
         AND d."tenant_id" = NEW."tenant_id"
         AND d."deleted_at" IS NULL
     ) THEN
    RAISE EXCEPTION 'DSGVO-Ergebnisdokument fehlt oder gehört zu einem anderen Tenant.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('COMPLETED', 'REJECTED') THEN
    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."created_by_staff" IS DISTINCT FROM OLD."created_by_staff"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
       OR NEW."subject_ref_id" IS DISTINCT FROM OLD."subject_ref_id"
       OR NEW."subject_email" IS DISTINCT FROM OLD."subject_email"
       OR NEW."subject_name" IS DISTINCT FROM OLD."subject_name"
       OR NEW."description" IS DISTINCT FROM OLD."description"
       OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
       OR NEW."due_date" IS DISTINCT FROM OLD."due_date"
       OR NEW."notes" IS DISTINCT FROM OLD."notes"
       OR NEW."result_document_id" IS DISTINCT FROM OLD."result_document_id"
       OR NEW."result_sha256" IS DISTINCT FROM OLD."result_sha256"
       OR NEW."result_prepared_at" IS DISTINCT FROM OLD."result_prepared_at"
       OR NEW."result_prepared_by" IS DISTINCT FROM OLD."result_prepared_by"
       OR NEW."result_reviewed_at" IS DISTINCT FROM OLD."result_reviewed_at"
       OR NEW."result_reviewed_by" IS DISTINCT FROM OLD."result_reviewed_by"
       OR NEW."response_sent_at" IS DISTINCT FROM OLD."response_sent_at"
       OR NEW."response_method" IS DISTINCT FROM OLD."response_method"
       OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
       OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
       OR NEW."completed_by_staff" IS DISTINCT FROM OLD."completed_by_staff" THEN
      RAISE EXCEPTION 'Abgeschlossener DSGVO-Nachweis ist unveränderlich.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- Canonical definition: app.tax_notice_require_progress_evidence()
CREATE OR REPLACE FUNCTION app.tax_notice_require_progress_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN (
    'EINSPRUCH'::public.tax_notice_status,
    'ABGEHOLFEN'::public.tax_notice_status,
    'TEILABHILFE'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (NEW.appeal_filed_at IS NULL OR NEW.appeal_filed_by IS NULL) THEN
    RAISE EXCEPTION 'appeal filing evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'ABGEHOLFEN'::public.tax_notice_status
     AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status IN (
    'TEILABHILFE'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (
    NEW.appeal_resolved_at IS NULL
    OR NEW.appeal_decision_received_at IS NULL
    OR NEW.appeal_decision_legal_remedy_instruction_valid IS NULL
    OR NEW.klage_deadline IS NULL
  ) THEN
    RAISE EXCEPTION 'appeal decision evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'KLAGE'::public.tax_notice_status
     AND (NEW.klage_filed_at IS NULL OR NEW.klage_filed_by IS NULL) THEN
    RAISE EXCEPTION 'court filing evidence must be completed before status progress';
  END IF;

  RETURN NEW;
END;
$function$
;

-- Canonical definition: app.tax_notice_set_appeal_deadline()
CREATE OR REPLACE FUNCTION app.tax_notice_set_appeal_deadline()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  notification_date DATE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.appeal_deadline IS NOT DISTINCT FROM OLD.appeal_deadline
     AND (
       NEW.notice_date IS DISTINCT FROM OLD.notice_date
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
       OR NEW.legal_remedy_instruction_valid IS DISTINCT FROM OLD.legal_remedy_instruction_valid
     ) THEN
    NEW.appeal_deadline := NULL;
  END IF;

  IF NEW.appeal_deadline IS NULL THEN
    IF NEW.delivery_method NOT IN ('POST', 'POST_ABROAD', 'ELECTRONIC', 'DATA_RETRIEVAL') THEN
      IF NEW.received_at IS NULL THEN
        RAISE EXCEPTION 'received_at is required for service without a statutory fiction';
      END IF;
      notification_date := NEW.received_at;
    ELSE
      notification_date := CASE
        WHEN NEW.delivery_method = 'POST_ABROAD'
          THEN (NEW.notice_date + INTERVAL '1 month')::date
        ELSE NEW.notice_date +
          CASE WHEN NEW.notice_date < DATE '2025-01-01' THEN 3 ELSE 4 END
      END;
      IF NEW.delivery_method IN ('POST', 'POST_ABROAD', 'ELECTRONIC')
         AND NEW.received_at IS NOT NULL
         AND NEW.received_at > notification_date THEN
        notification_date := NEW.received_at;
      END IF;
    END IF;

    NEW.appeal_deadline := (
      notification_date +
      CASE
        WHEN NEW.legal_remedy_instruction_valid THEN INTERVAL '1 month'
        ELSE INTERVAL '1 year'
      END
    )::date;
  END IF;
  RETURN NEW;
END;
$function$
;

-- Preserve the deliberately restricted helper privilege after replacement.
REVOKE ALL ON FUNCTION app.gwg_check_has_confirmed_identity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gwg_check_has_confirmed_identity(UUID) TO taxtronik_app;

DROP TRIGGER IF EXISTS document_gwg_invite_scope_and_claim ON public.document;
CREATE TRIGGER document_gwg_invite_scope_and_claim BEFORE INSERT OR DELETE OR UPDATE ON document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_document_invite_and_claim();
DROP TRIGGER IF EXISTS document_version_block_gwg_destruction ON public.document_version;
CREATE TRIGGER document_version_block_gwg_destruction BEFORE INSERT OR DELETE OR UPDATE ON document_version FOR EACH ROW EXECUTE FUNCTION app.block_version_during_gwg_destruction();
DROP TRIGGER IF EXISTS dsgvo_request_terminal_evidence_immutable ON public.dsgvo_request;
CREATE TRIGGER dsgvo_request_terminal_evidence_immutable BEFORE INSERT OR UPDATE ON dsgvo_request FOR EACH ROW EXECUTE FUNCTION app.protect_dsgvo_terminal_evidence();
DROP TRIGGER IF EXISTS gwg_beneficial_owner_identity_assignment_invalidate ON public.gwg_beneficial_owner;
CREATE TRIGGER gwg_beneficial_owner_identity_assignment_invalidate AFTER UPDATE OF full_name, birth_date, birth_place, residence, nationality ON gwg_beneficial_owner FOR EACH ROW EXECUTE FUNCTION app.invalidate_gwg_beneficial_owner_identity_assignment();
DROP TRIGGER IF EXISTS gwg_id_document_scope_and_claim ON public.gwg_id_document;
CREATE TRIGGER gwg_id_document_scope_and_claim BEFORE INSERT OR DELETE OR UPDATE ON gwg_id_document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_scope_and_claim();
DROP TRIGGER IF EXISTS gwg_id_document_subject_and_set_guard ON public.gwg_id_document;
CREATE TRIGGER gwg_id_document_subject_and_set_guard BEFORE INSERT OR UPDATE ON gwg_id_document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_subject_and_set();
DROP TRIGGER IF EXISTS poa_protect_integrity ON public.power_of_attorney;
CREATE TRIGGER poa_protect_integrity BEFORE INSERT OR UPDATE ON power_of_attorney FOR EACH ROW EXECUTE FUNCTION app.poa_protect_integrity();
DROP TRIGGER IF EXISTS tax_notice_appeal_deadline_trigger ON public.tax_notice;
CREATE TRIGGER tax_notice_appeal_deadline_trigger BEFORE INSERT OR UPDATE OF notice_date, received_at, delivery_method, legal_remedy_instruction_valid ON tax_notice FOR EACH ROW EXECUTE FUNCTION app.tax_notice_set_appeal_deadline();
DROP TRIGGER IF EXISTS tax_notice_progress_evidence_trigger ON public.tax_notice;
CREATE TRIGGER tax_notice_progress_evidence_trigger BEFORE UPDATE OF status ON tax_notice FOR EACH ROW EXECUTE FUNCTION app.tax_notice_require_progress_evidence();

ALTER TABLE public.dsgvo_request DROP CONSTRAINT IF EXISTS dsgvo_request_result_evidence_pairs_check;
ALTER TABLE public.dsgvo_request ADD CONSTRAINT dsgvo_request_result_evidence_pairs_check CHECK ((result_prepared_at IS NULL) = (result_prepared_by IS NULL) AND (result_reviewed_at IS NULL) = (result_reviewed_by IS NULL) AND (result_sha256 IS NULL OR result_prepared_at IS NOT NULL) AND (result_reviewed_at IS NULL OR result_sha256 IS NOT NULL OR result_document_id IS NOT NULL) AND (result_prepared_at IS NULL OR result_reviewed_at IS NULL OR result_reviewed_at >= result_prepared_at)) NOT VALID;
ALTER TABLE public.gwg_id_document DROP CONSTRAINT IF EXISTS gwg_id_document_beneficial_owner_subject_id_fkey;
ALTER TABLE public.gwg_id_document ADD CONSTRAINT gwg_id_document_beneficial_owner_subject_id_fkey FOREIGN KEY (beneficial_owner_subject_id) REFERENCES gwg_beneficial_owner(id) ON DELETE SET NULL;
ALTER TABLE public.gwg_id_document DROP CONSTRAINT IF EXISTS gwg_id_document_natural_client_subject_id_fkey;
ALTER TABLE public.gwg_id_document ADD CONSTRAINT gwg_id_document_natural_client_subject_id_fkey FOREIGN KEY (natural_client_subject_id) REFERENCES client(id) ON DELETE SET NULL;
ALTER TABLE public.gwg_id_document DROP CONSTRAINT IF EXISTS gwg_id_document_representative_subject_id_fkey;
ALTER TABLE public.gwg_id_document ADD CONSTRAINT gwg_id_document_representative_subject_id_fkey FOREIGN KEY (representative_subject_id) REFERENCES gwg_representative(id) ON DELETE SET NULL;
ALTER TABLE public.tax_notice DROP CONSTRAINT IF EXISTS tax_notice_appeal_filing_evidence_check;
ALTER TABLE public.tax_notice ADD CONSTRAINT tax_notice_appeal_filing_evidence_check CHECK (status <> 'EINSPRUCH'::tax_notice_status OR appeal_filed_at IS NOT NULL AND appeal_filed_by IS NOT NULL) NOT VALID;
ALTER TABLE public.tax_notice DROP CONSTRAINT IF EXISTS tax_notice_court_filing_evidence_check;
ALTER TABLE public.tax_notice ADD CONSTRAINT tax_notice_court_filing_evidence_check CHECK (status <> 'KLAGE'::tax_notice_status OR klage_filed_at IS NOT NULL AND klage_filed_by IS NOT NULL) NOT VALID;
ALTER TABLE public.tax_notice DROP CONSTRAINT IF EXISTS tax_notice_event_sequence_check;
ALTER TABLE public.tax_notice ADD CONSTRAINT tax_notice_event_sequence_check CHECK ((appeal_filed_at IS NULL OR appeal_filed_at::date >= notice_date) AND (appeal_decision_received_at IS NULL OR appeal_filed_at IS NULL OR appeal_decision_received_at >= appeal_filed_at::date) AND (appeal_resolved_at IS NULL OR appeal_filed_at IS NULL OR appeal_resolved_at::date >= appeal_filed_at::date) AND (klage_filed_at IS NULL OR appeal_decision_received_at IS NULL OR klage_filed_at::date >= appeal_decision_received_at) AND (legal_final_at IS NULL OR legal_final_at::date >= notice_date AND (appeal_filed_at IS NULL OR legal_final_at::date >= appeal_filed_at::date) AND (appeal_resolved_at IS NULL OR legal_final_at::date >= appeal_resolved_at::date) AND (appeal_decision_received_at IS NULL OR legal_final_at::date >= appeal_decision_received_at) AND (klage_filed_at IS NULL OR legal_final_at::date >= klage_filed_at::date))) NOT VALID;
ALTER TABLE public.tax_notice DROP CONSTRAINT IF EXISTS tax_notice_legal_final_evidence_check;
ALTER TABLE public.tax_notice ADD CONSTRAINT tax_notice_legal_final_evidence_check CHECK (status <> 'RECHTSKRAEFTIG'::tax_notice_status OR legal_final_at IS NOT NULL AND legal_final_by IS NOT NULL) NOT VALID;

-- The currently applied 090000 row selects the exact historical state. This
-- makes the forward migration fail closed even when the wrapper was bypassed.
DO $history_attestation$
DECLARE
  repair_checksum TEXT;
BEGIN
  SELECT checksum
    INTO repair_checksum
    FROM public._prisma_migrations
   WHERE migration_name = '20260809000000_repair_known_legacy_migration_drift'
     AND finished_at IS NOT NULL
     AND rolled_back_at IS NULL;

  IF repair_checksum IS NULL OR repair_checksum NOT IN (
    '9f04a8abdd6a5b3e35e007855942a654bd19ea6122046415a50e07f50e7ecab6',
    '8806a22b6f2c423a37384812952aa69a92e8bf85acbf575f6d7a552763b33102',
    '028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74'
  ) THEN
    RAISE EXCEPTION 'Unknown checksum for migration 20260809000000: %',
      COALESCE(repair_checksum, '<missing>');
  END IF;
END;
$history_attestation$;

-- Reconcile only explicitly attested pre-release, intermediate and CRLF
-- variants. Each target checksum is the LF hash stored in the Git history.
WITH known_history(migration_name, known_checksum, canonical_checksum) AS (
  VALUES
    ('20260801003400_gwg_fail_closed_and_destruction', '0a14d7d3651dfef0e0cffe71c38075c3e8f08cbcc4ea54aa8da6e429bebcea6b', '522bdf1be8bedcf4ccb14cc3b8ea8902f6c99f08acbc0271e5c8e8c427f71fb5'),
    ('20260801003500_tax_notice_event_dates', 'fc4f82dd6dc4ba389cd668a41a308feba3ea56965bde3913afb0cd2c35d2478f', 'f41ab83c711f257c6613f84ebfb1e98d75290a9def54c534e10ebbe3152c07c5'),
    ('20260801003510_dsgvo_request_evidence', '0c6e0ae08723053157c1e58f25576d04a2ceac3c4aaea31a861234af50532ffd', 'b066ce8e1843dea2b18e781fdf7bbba9755b54badd47e9f658c2d5fb2d95c9f3'),
    ('20260801003600_poa_signing_snapshot', '225753c9c03bd05c717f7e0f151a7ac2ed1db87c75f86b3de4e3e6a13e3b1dfa', '94d412607abcca7ef88748dd75629821398369f01acbcc6e2f13c92518923d1d'),
    ('20260801003700_n8n_workflow_routes', 'fca7f51d9eb02387fb20ee8c3319564ec3f0dc06bf9487a32f187cd4d51d0394', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387'),
    ('20260801003800_n8n_callback_receipts', 'ab8a651682b04d771320c8a628047bee8e24721d84f483afc857600edd53c303', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a'),
    ('20260801003900_n8n_delivery_ops_index', '6ac5ada54eadc5d9e19a2777b77ec5aa7354eefdf04fe012a31cda99c9bb2f94', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1'),
    ('20260801004000_poa_created_at_db_clock', '169c5c5afd6dcc18d08cf9122a00e6553bce268005f462a01e9a43fe9557e605', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1'),
    ('20260801004200_gwg_destruction_lifecycle_lock', 'a011462a9453eaae29d0e3b5065d325970ba81803b92e97fc4e4a25c361d688b', '22bb09784eb9ac0c442c988324f9b362dad1987270186450b528c3449851f28d'),
    ('20260801004300_gwg_identity_subjects_and_document_sets', '861f2fe53dd2e900d5697b80b9632d086f027bc3df65199232194c96e66d639e', 'dbf3d368cbe85a249bdf06b1947163d69b879bd8017c5c30a800220c9c774d3b'),
    ('20260801004400_legacy_gwg_guard_recovery', '4390e25b53febbb93ec0dc7c0b29793e7f5e7827bea1d8b23ff361b4faf2dd1c', 'bda88a84cf016044148b08a63ca677957176c16b464efd9bbad71ca15a22a8e3'),
    ('20260809000000_repair_known_legacy_migration_drift', '9f04a8abdd6a5b3e35e007855942a654bd19ea6122046415a50e07f50e7ecab6', '028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74'),
    ('20260809000000_repair_known_legacy_migration_drift', '8806a22b6f2c423a37384812952aa69a92e8bf85acbf575f6d7a552763b33102', '028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74')
)
UPDATE public._prisma_migrations AS ledger
   SET checksum = known.canonical_checksum
  FROM known_history AS known
 WHERE ledger.migration_name = known.migration_name
   AND ledger.checksum = known.known_checksum
   AND ledger.finished_at IS NOT NULL
   AND ledger.rolled_back_at IS NULL;

-- Reconcile only the eleven attested pre-release hashes. An unknown checksum is
-- never rewritten here and is rejected by verify-migration-ledger.mjs.
WITH known_legacy(migration_name, legacy_checksum, canonical_checksum) AS (
  VALUES
    ('20260801003400_gwg_fail_closed_and_destruction', '20e0ac5a2c1d6d47c7c606cd3915b6297418c25ece1695e345152ebc20296152', '522bdf1be8bedcf4ccb14cc3b8ea8902f6c99f08acbc0271e5c8e8c427f71fb5'),
    ('20260801003500_tax_notice_event_dates', 'aca1080fb6a838263c178ffc9ee6966168df08338a82d5c8c2f2cf5133404d05', 'f41ab83c711f257c6613f84ebfb1e98d75290a9def54c534e10ebbe3152c07c5'),
    ('20260801003510_dsgvo_request_evidence', '85f37286af75f978f46e80f026768f1bfa36243f8717f6152ac3118574501966', 'b066ce8e1843dea2b18e781fdf7bbba9755b54badd47e9f658c2d5fb2d95c9f3'),
    ('20260801003600_poa_signing_snapshot', '6a180f40b3d7e57f3bee1623b1e05d8759ae773a90b2ae3e882e1b847c43bab6', '94d412607abcca7ef88748dd75629821398369f01acbcc6e2f13c92518923d1d'),
    ('20260801003700_n8n_workflow_routes', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387'),
    ('20260801003800_n8n_callback_receipts', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a'),
    ('20260801003900_n8n_delivery_ops_index', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1'),
    ('20260801004000_poa_created_at_db_clock', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1'),
    ('20260801004200_gwg_destruction_lifecycle_lock', '90efb4b93035dbb4b685b8b2f36395badaabe3cb0e36389031a21155e90479ed', '22bb09784eb9ac0c442c988324f9b362dad1987270186450b528c3449851f28d'),
    ('20260801004300_gwg_identity_subjects_and_document_sets', 'a7c91cb2cefdff27708b8f725a2c5bcee24578fdce8899f09b25bf8c124154d1', 'dbf3d368cbe85a249bdf06b1947163d69b879bd8017c5c30a800220c9c774d3b'),
    ('20260801004400_legacy_gwg_guard_recovery', 'b84f3eff33972398cfde95521cc44671639fc0f34bbfb0f872afbc2e19951b6f', 'bda88a84cf016044148b08a63ca677957176c16b464efd9bbad71ca15a22a8e3')
)
UPDATE public._prisma_migrations AS ledger
   SET checksum = known.canonical_checksum
  FROM known_legacy AS known
 WHERE ledger.migration_name = known.migration_name
   AND ledger.checksum = known.legacy_checksum
   AND ledger.finished_at IS NOT NULL
   AND ledger.rolled_back_at IS NULL;

DO $repair_attestation$
DECLARE
  invalid_rows TEXT;
BEGIN
  WITH canonical(migration_name, checksum) AS (
    VALUES
      ('20260801003400_gwg_fail_closed_and_destruction', '522bdf1be8bedcf4ccb14cc3b8ea8902f6c99f08acbc0271e5c8e8c427f71fb5'),
      ('20260801003500_tax_notice_event_dates', 'f41ab83c711f257c6613f84ebfb1e98d75290a9def54c534e10ebbe3152c07c5'),
      ('20260801003510_dsgvo_request_evidence', 'b066ce8e1843dea2b18e781fdf7bbba9755b54badd47e9f658c2d5fb2d95c9f3'),
      ('20260801003600_poa_signing_snapshot', '94d412607abcca7ef88748dd75629821398369f01acbcc6e2f13c92518923d1d'),
      ('20260801003700_n8n_workflow_routes', 'a7ab046abe92205f430202af01e0a0f955ad074eeb696a08842864102bf83387'),
      ('20260801003800_n8n_callback_receipts', '9ea34ff62642812abd7141b85b3f48df5973b25db0f1e69d390b85f50a2a611a'),
      ('20260801003900_n8n_delivery_ops_index', 'f7af0aef8e6d3a15344651c13869e7eebf8ea7a40e36b12e27257a29fdbf79d1'),
      ('20260801004000_poa_created_at_db_clock', '5b7441b7eb0d3148a6e4418fbdc61df8a7730cf856fa5f2cf27e3276228a89d1'),
      ('20260801004200_gwg_destruction_lifecycle_lock', '22bb09784eb9ac0c442c988324f9b362dad1987270186450b528c3449851f28d'),
      ('20260801004300_gwg_identity_subjects_and_document_sets', 'dbf3d368cbe85a249bdf06b1947163d69b879bd8017c5c30a800220c9c774d3b'),
      ('20260801004400_legacy_gwg_guard_recovery', 'bda88a84cf016044148b08a63ca677957176c16b464efd9bbad71ca15a22a8e3')
  )
  SELECT string_agg(canonical.migration_name, ', ' ORDER BY canonical.migration_name)
    INTO invalid_rows
    FROM canonical
    LEFT JOIN public._prisma_migrations AS ledger
      ON ledger.migration_name = canonical.migration_name
     AND ledger.finished_at IS NOT NULL
     AND ledger.rolled_back_at IS NULL
   WHERE ledger.migration_name IS NULL
      OR ledger.checksum <> canonical.checksum;

  IF invalid_rows IS NOT NULL THEN
    RAISE EXCEPTION 'Migration ledger could not be attested after legacy repair: %', invalid_rows
      USING ERRCODE = 'data_exception';
  END IF;
END;
$repair_attestation$;

DO $history_convergence$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public._prisma_migrations
     WHERE migration_name = '20260809000000_repair_known_legacy_migration_drift'
       AND checksum = '028fdbe47d7fd9901bc3b042e3dce078ac2283247b48b742f35e89db8e559d74'
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Migration 20260809000000 did not converge to its canonical checksum'
      USING ERRCODE = 'data_exception';
  END IF;
END;
$history_convergence$;

COMMIT;
