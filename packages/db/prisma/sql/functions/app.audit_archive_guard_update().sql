CREATE OR REPLACE FUNCTION app.audit_archive_guard_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF (NEW."id", NEW."tenant_id", NEW."from_audit_id", NEW."to_audit_id",
      NEW."from_occurred_at", NEW."to_occurred_at", NEW."entry_count",
      NEW."first_prev_hash", NEW."last_this_hash", NEW."file_sha256",
      NEW."file_size_bytes", NEW."storage_bucket", NEW."storage_key", NEW."mode",
      NEW."archived_at", NEW."archived_by")
     IS NOT DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."from_audit_id", OLD."to_audit_id",
      OLD."from_occurred_at", OLD."to_occurred_at", OLD."entry_count",
      OLD."first_prev_hash", OLD."last_this_hash", OLD."file_sha256",
      OLD."file_size_bytes", OLD."storage_bucket", OLD."storage_key", OLD."mode",
      OLD."archived_at", OLD."archived_by")
     AND OLD."tsa_status" = 'PENDING'
     AND OLD."tsa_response_blob" IS NULL
     AND OLD."tsa_serial" IS NULL
     AND NEW."tsa_status" = 'STAMPED_LATE'
     AND NEW."tsa_response_blob" IS NOT NULL
     AND NEW."tsa_stamped_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_archive ist insert-only (Hash-Chain-Belege)';
END;
$function$;
