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
$function$;
