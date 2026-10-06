CREATE OR REPLACE FUNCTION app.tax_notice_guard_partial_relief_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
       AND (
         NEW."partial_relief_received_at" IS NULL
         OR NEW."partial_relief_received_by" IS NULL
       ) THEN
      RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."partial_relief_received_at" IS NOT NULL
     AND (
       NEW."partial_relief_received_at" IS DISTINCT FROM OLD."partial_relief_received_at"
       OR NEW."partial_relief_received_by" IS DISTINCT FROM OLD."partial_relief_received_by"
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence is immutable once recorded'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
     AND OLD."status" IS DISTINCT FROM NEW."status"
     AND (
       NEW."partial_relief_received_at" IS NULL
       OR NEW."partial_relief_received_by" IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
  END IF;

  RETURN NEW;
END;
$function$;
