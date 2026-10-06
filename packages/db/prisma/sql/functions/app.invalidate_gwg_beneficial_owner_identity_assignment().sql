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
$function$;
