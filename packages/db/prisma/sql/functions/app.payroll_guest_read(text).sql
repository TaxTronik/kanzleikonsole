CREATE OR REPLACE FUNCTION app.payroll_guest_read(p_session text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE pid UUID; result JSONB;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('id',i.id,'tenantId',i.tenant_id,'revision',i.revision,'status',i.status,'label',i.employee_label,
 'schema',i.schema_snapshot->'employee','answers',COALESCE(d.answers,'{}'::jsonb),'submitted',i.employee_submitted_at IS NOT NULL,'expiresAt',i.expires_at,
 'reviewNote',i.review_note,'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'status',a.status)) FROM public.payroll_attachment a WHERE a.intake_id=i.id AND a.audience='EMPLOYEE'),'[]'::jsonb))
 INTO result FROM public.payroll_intake i LEFT JOIN public.payroll_employee_data d ON d.intake_id=i.id WHERE i.id=pid;
 RETURN result;
END $function$;
