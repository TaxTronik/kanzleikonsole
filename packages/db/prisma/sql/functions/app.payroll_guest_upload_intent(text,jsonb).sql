CREATE OR REPLACE FUNCTION app.payroll_guest_upload_intent(p_session text, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE pid UUID; i public.payroll_intake; sid UUID; aid UUID;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO i FROM public.payroll_intake WHERE id=pid FOR UPDATE;
 IF i.status NOT IN ('DRAFT','RETURNED') OR i.employee_submitted_at IS NOT NULL THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.payroll_attachment WHERE intake_id=pid AND audience='EMPLOYEE')>=20 THEN RAISE EXCEPTION 'Attachment limit'; END IF;
 SELECT id INTO sid FROM public.payroll_guest_session WHERE token_hash=p_session;
 INSERT INTO public.payroll_attachment(tenant_id,intake_id,audience,uploaded_by,revision,filename,mime_type,storage_bucket,storage_key,sha256,size_bytes)
 VALUES(i.tenant_id,pid,'EMPLOYEE',sid,i.revision,p_data->>'filename',p_data->>'mimeType',p_data->>'storageBucket',p_data->>'storageKey',p_data->>'sha256',(p_data->>'sizeBytes')::bigint) RETURNING id INTO aid;
 RETURN aid;
END $function$;
