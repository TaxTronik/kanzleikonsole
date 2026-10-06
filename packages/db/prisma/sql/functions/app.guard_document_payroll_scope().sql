CREATE OR REPLACE FUNCTION app.guard_document_payroll_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.requires_payroll_access AND NOT NEW.requires_payroll_access THEN RAISE EXCEPTION 'payroll scope cannot be downgraded'; END IF;
 IF NEW.requires_payroll_access AND NEW.shared_with_client_at IS NOT NULL THEN RAISE EXCEPTION 'payroll archive cannot be shared with the general portal'; END IF;
 RETURN NEW;
END $function$;
