-- Allgemeine Angaben gehören zur Person und dürfen nicht erst beim Zuweisen
-- der Rolle „wirtschaftlich berechtigt“ erhoben werden. Reine Vertreter-
-- personen erhalten deshalb dieselben strukturierten Kerndaten. Bei bereits
-- ausdrücklich verknüpften Doppelrollen werden die vorhandenen Owner-Angaben
-- verlustfrei übernommen.
BEGIN;

ALTER TABLE public."gwg_representative"
  ADD COLUMN "birth_date" DATE,
  ADD COLUMN "birth_place" TEXT,
  ADD COLUMN "residence" TEXT,
  ADD COLUMN "nationality" TEXT,
  ADD COLUMN "is_pep" BOOLEAN;

UPDATE public."gwg_representative" representative
   SET "full_name" = owner."full_name",
       "birth_date" = owner."birth_date",
       "birth_place" = owner."birth_place",
       "residence" = owner."residence",
       "nationality" = owner."nationality",
       "is_pep" = owner."is_pep"
  FROM public."gwg_beneficial_owner" owner
 WHERE representative."linked_beneficial_owner_id" = owner."id"
   AND representative."gwg_check_id" = owner."gwg_check_id";

-- Jede Änderung allgemeiner Identitätsangaben entwertet wie bisher Name und
-- Rollenverknüpfung die bestätigte Ausweiszuordnung der gesamten Satzgruppe.
CREATE OR REPLACE FUNCTION app.invalidate_gwg_representative_identity_assignment()
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
       NEW."nationality",
       NEW."linked_beneficial_owner_id"
     ) IS NOT DISTINCT FROM ROW(
       OLD."full_name",
       OLD."birth_date",
       OLD."birth_place",
       OLD."residence",
       OLD."nationality",
       OLD."linked_beneficial_owner_id"
     )
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

DROP TRIGGER IF EXISTS gwg_representative_identity_assignment_invalidate
  ON public."gwg_representative";

CREATE TRIGGER gwg_representative_identity_assignment_invalidate
AFTER UPDATE OF
  "full_name",
  "birth_date",
  "birth_place",
  "residence",
  "nationality",
  "linked_beneficial_owner_id"
ON public."gwg_representative"
FOR EACH ROW
EXECUTE FUNCTION app.invalidate_gwg_representative_identity_assignment();

COMMIT;
