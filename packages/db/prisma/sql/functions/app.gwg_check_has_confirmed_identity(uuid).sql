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
$function$;
