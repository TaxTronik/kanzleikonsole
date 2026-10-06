CREATE OR REPLACE FUNCTION app.payroll_guest_upload_finish(p_session text, p_id uuid, p_version text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE pid UUID;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL OR length(p_version)=0 THEN RETURN false; END IF;
 UPDATE public.payroll_attachment SET storage_version_id=p_version,status='COMPLETE' WHERE id=p_id AND intake_id=pid AND audience='EMPLOYEE' AND status='PENDING';
 RETURN FOUND;
END $function$;
