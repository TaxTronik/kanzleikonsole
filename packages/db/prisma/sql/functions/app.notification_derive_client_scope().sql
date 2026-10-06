CREATE OR REPLACE FUNCTION app.notification_derive_client_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  resource_was_found BOOLEAN := FALSE;
  expected_client_id UUID;
  staff_tenant_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
    OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id"
    OR NEW."resource_type" IS DISTINCT FROM OLD."resource_type"
    OR NEW."resource_id" IS DISTINCT FROM OLD."resource_id"
  ) THEN
    RAISE EXCEPTION 'Notification-Scope und Ressourcenlink sind unveränderlich'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."resource_type" IS NULL AND NEW."resource_id" IS NULL THEN
    resource_was_found := TRUE;
  ELSIF NEW."resource_type" IS NULL THEN
    RAISE EXCEPTION 'Notification-Ressourcenlink ist nur halb gesetzt'
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
  CASE NEW."resource_type"
    WHEN 'tax_notice' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."tax_notice" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_reminder' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_reminder" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'pending_binder' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."pending_binder" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'tax_deadline' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."tax_deadline" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'invoice' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."invoice" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'gwg_check' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."gwg_check" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'power_of_attorney' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."power_of_attorney" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'phone_note' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."phone_note" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client' THEN
      SELECT source."id" INTO expected_client_id
        FROM public."client" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'document' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."document" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'appointment' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."appointment" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'appointment_request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."appointment_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_master_change_request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_master_change_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_contact' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_contact" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_consent' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_consent" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_reminder_note' THEN
      SELECT reminder."client_id" INTO expected_client_id
        FROM public."client_reminder_note" note
        JOIN public."client_reminder" reminder
          ON reminder."id" = note."reminder_id"
         AND reminder."tenant_id" = note."tenant_id"
       WHERE note."tenant_id" = NEW."tenant_id"
         AND note."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF note, reminder;
    WHEN 'gwg_onboarding_invite' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."gwg_onboarding_invite" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'gwg_id_document' THEN
      SELECT check_row."client_id" INTO expected_client_id
        FROM public."gwg_id_document" id_document
        JOIN public."gwg_check" check_row
          ON check_row."id" = id_document."gwg_check_id"
       WHERE check_row."tenant_id" = NEW."tenant_id"
         AND id_document."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF id_document, check_row;
    WHEN 'risk_marking' THEN
      SELECT analysis."client_id" INTO expected_client_id
        FROM public."risk_marking" marking
        JOIN public."risk_analysis" analysis
          ON analysis."id" = marking."analysis_id"
         AND analysis."tenant_id" = marking."tenant_id"
       WHERE marking."tenant_id" = NEW."tenant_id"
         AND marking."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF marking, analysis;
    WHEN 'risk_research_result' THEN
      SELECT COALESCE(request_analysis."client_id", marking_analysis."client_id", shelf."client_id")
        INTO expected_client_id
        FROM public."risk_research_result" result
        LEFT JOIN public."risk_research_request" research_request
          ON research_request."id" = result."research_request_id"
         AND research_request."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" request_analysis
          ON request_analysis."id" = research_request."analysis_id"
         AND request_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_marking" marking
          ON marking."id" = result."marking_id"
         AND marking."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" marking_analysis
          ON marking_analysis."id" = marking."analysis_id"
         AND marking_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."document" shelf
          ON shelf."id" = result."shelf_document_id"
         AND shelf."tenant_id" = result."tenant_id"
       WHERE result."tenant_id" = NEW."tenant_id"
         AND result."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF result;
    WHEN 'vacation_request' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."vacation_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'absence' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."absence" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'tenant' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."tenant" source
       WHERE source."id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'audit_log', 'backup_drill', 'mail', 'staff_user', 'tax_news_item' THEN
      resource_was_found := TRUE;
    ELSE
      RAISE EXCEPTION 'Unklassifizierter Notification-Ressourcentyp: %',
        NEW."resource_type"
        USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  END IF;

  IF NOT resource_was_found THEN
    resource_was_found := FOUND;
  END IF;
  IF NOT resource_was_found THEN
    RAISE EXCEPTION 'Bekannte Notification-Ressource existiert nicht im Tenant-Scope (%:%)',
      NEW."resource_type", NEW."resource_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."client_id" IS NOT NULL
     AND NEW."client_id" IS DISTINCT FROM expected_client_id THEN
    RAISE EXCEPTION 'Notification.client_id widerspricht dem bekannten Fachobjekt'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."client_id" := expected_client_id;

  IF NEW."staff_id" IS NOT NULL THEN
    SELECT staff."tenant_id" INTO staff_tenant_id
      FROM public."staff_user" staff
     WHERE staff."id" = NEW."staff_id"
     FOR KEY SHARE;
    IF NOT FOUND OR staff_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
      RAISE EXCEPTION 'Notification.staff_id gehört nicht zum Tenant-Scope'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
