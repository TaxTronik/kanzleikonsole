CREATE OR REPLACE FUNCTION app.payroll_capture_revision(pid uuid, p_actor uuid, p_type text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 INSERT INTO public.payroll_revision(tenant_id,intake_id,revision,snapshot,actor_id,actor_type)
 SELECT i.tenant_id,i.id,i.revision,jsonb_build_object('schema',i.schema_snapshot,'employer',i.employer_answers,'employee',COALESCE(d.answers,'{}'::jsonb),
 'status',i.status,'employerConfirmedAt',i.employer_confirmed_at,'employeeSubmittedAt',i.employee_submitted_at,'advisorNumber',i.advisor_number,'clientNumber',i.client_number,'personnelNumber',i.personnel_number,'numbersConfirmedAt',i.numbers_confirmed_at,
 'externalTasks',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',t.kind,'status',t.status,'evidence',t.evidence,'recordedAt',t.recorded_at,'recordedByStaff',t.recorded_by_staff) ORDER BY t.kind) FROM public.payroll_external_task t WHERE t.intake_id=i.id),'[]'::jsonb),
 'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'sha256',a.sha256,'versionId',a.storage_version_id) ORDER BY a.id) FROM public.payroll_attachment a WHERE a.intake_id=i.id AND a.status='COMPLETE' AND NOT EXISTS(SELECT 1 FROM public.payroll_export e WHERE e.attachment_id=a.id)),'[]'::jsonb)),p_actor,p_type
 FROM public.payroll_intake i LEFT JOIN public.payroll_employee_data d ON d.intake_id=i.id WHERE i.id=pid;
$function$;
