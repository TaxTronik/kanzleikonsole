CREATE OR REPLACE FUNCTION app.notification_resource_scope(p_tenant_id uuid, p_resource_type text, p_resource_id text, OUT resource_is_known boolean, OUT resource_was_found boolean, OUT resolved_client_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_resource_uuid UUID;
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    resource_is_known := FALSE;
    resource_was_found := FALSE;
    resolved_client_id := NULL;
    RETURN;
  END IF;

  resource_is_known := TRUE;
  resource_was_found := FALSE;
  resolved_client_id := NULL;

  IF p_resource_type IS NULL AND p_resource_id IS NULL THEN
    resource_was_found := TRUE;
    RETURN;
  ELSIF p_resource_type IS NULL THEN
    resource_is_known := FALSE;
    RETURN;
  END IF;

  v_resource_uuid := app.canonical_uuid_or_null(p_resource_id);

  CASE p_resource_type
    WHEN 'tax_notice' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.tax_notice source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client_reminder' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_reminder source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'pending_binder' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.pending_binder source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'tax_deadline' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.tax_deadline source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'invoice' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.invoice source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'gwg_check' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.gwg_check source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'power_of_attorney' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.power_of_attorney source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'phone_note' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.phone_note source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client' THEN
      SELECT source.id INTO resolved_client_id
        FROM public.client source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'document' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.document source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'appointment' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.appointment source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'appointment_request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.appointment_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client_master_change_request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_master_change_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client_contact' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_contact source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client_consent' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_consent source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'client_reminder_note' THEN
      SELECT reminder.client_id INTO resolved_client_id
        FROM public.client_reminder_note note
        JOIN public.client_reminder reminder
          ON reminder.id = note.reminder_id
         AND reminder.tenant_id = note.tenant_id
       WHERE note.tenant_id = p_tenant_id
         AND note.id = v_resource_uuid;
    WHEN 'gwg_onboarding_invite' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.gwg_onboarding_invite source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'gwg_id_document' THEN
      SELECT check_row.client_id INTO resolved_client_id
        FROM public.gwg_id_document id_document
        JOIN public.gwg_check check_row
          ON check_row.id = id_document.gwg_check_id
       WHERE check_row.tenant_id = p_tenant_id
         AND id_document.id = v_resource_uuid;
    WHEN 'risk_marking' THEN
      SELECT analysis.client_id INTO resolved_client_id
        FROM public.risk_marking marking
        JOIN public.risk_analysis analysis
          ON analysis.id = marking.analysis_id
         AND analysis.tenant_id = marking.tenant_id
       WHERE marking.tenant_id = p_tenant_id
         AND marking.id = v_resource_uuid;
    WHEN 'risk_research_result' THEN
      SELECT COALESCE(
        request_analysis.client_id,
        marking_analysis.client_id,
        shelf.client_id
      ) INTO resolved_client_id
        FROM public.risk_research_result result
        LEFT JOIN public.risk_research_request research_request
          ON research_request.id = result.research_request_id
         AND research_request.tenant_id = result.tenant_id
        LEFT JOIN public.risk_analysis request_analysis
          ON request_analysis.id = research_request.analysis_id
         AND request_analysis.tenant_id = result.tenant_id
        LEFT JOIN public.risk_marking marking
          ON marking.id = result.marking_id
         AND marking.tenant_id = result.tenant_id
        LEFT JOIN public.risk_analysis marking_analysis
          ON marking_analysis.id = marking.analysis_id
         AND marking_analysis.tenant_id = result.tenant_id
        LEFT JOIN public.document shelf
          ON shelf.id = result.shelf_document_id
         AND shelf.tenant_id = result.tenant_id
       WHERE result.tenant_id = p_tenant_id
         AND result.id = v_resource_uuid;
    WHEN 'portal_inbox_thread' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.portal_inbox_thread source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'vacation_request' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.vacation_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'absence' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.absence source
       WHERE source.tenant_id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'tenant' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.tenant source
       WHERE source.id = p_tenant_id
         AND source.id = v_resource_uuid;
    WHEN 'audit_log', 'backup_drill', 'mail', 'staff_user', 'tax_news_item' THEN
      resource_was_found := TRUE;
      RETURN;
    ELSE
      resource_is_known := FALSE;
      RETURN;
  END CASE;

  resource_was_found := FOUND;
END;
$function$;
