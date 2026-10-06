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
$function$;
