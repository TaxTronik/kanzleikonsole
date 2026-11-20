CREATE OR REPLACE FUNCTION app.risk_research_notification_visible(p_tenant_id uuid, p_result_id text, p_staff_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p_tenant_id = app.current_tenant_id()
    AND (app.current_actor_type() = 'SYSTEM' OR
         (app.current_actor_type() = 'STAFF' AND (p_staff_id IS NULL OR p_staff_id = app.current_actor_id())))
    AND EXISTS (
      SELECT 1
      FROM public.risk_research_result r
      LEFT JOIN public.risk_research_request q ON q.id = r.research_request_id AND q.tenant_id = r.tenant_id
      LEFT JOIN public.risk_marking m ON m.id = r.marking_id AND m.tenant_id = r.tenant_id
      LEFT JOIN public.risk_analysis a ON a.id = COALESCE(q.analysis_id, m.analysis_id) AND a.tenant_id = r.tenant_id
      WHERE r.id = CASE WHEN p_result_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN p_result_id::uuid END AND r.tenant_id = p_tenant_id
        AND (r.research_request_id IS NULL OR q.id IS NOT NULL)
        AND (r.marking_id IS NULL OR m.id IS NOT NULL)
        AND (q.analysis_id IS NULL OR m.analysis_id IS NULL OR q.analysis_id = m.analysis_id)
        AND (
          -- Nur ein unkorrelierter Kanzleieingang darf ohne auflösbare Analyse erscheinen.
          (p_staff_id IS NULL AND r.research_request_id IS NULL AND r.marking_id IS NULL AND r.shelf_document_id IS NULL)
          OR a.vertraulich = FALSE OR
          (a.vertraulich AND a.client_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.staff_user s
            WHERE s.id = COALESCE(p_staff_id, app.current_actor_id()) AND s.tenant_id = a.tenant_id AND s.active AND (
              EXISTS (SELECT 1 FROM public.staff_role sr WHERE sr.staff_user_id = s.id AND sr.role IN ('ADMIN', 'PARTNER'))
              OR EXISTS (SELECT 1 FROM public.client_responsibility cr WHERE cr.tenant_id = a.tenant_id
                AND cr.client_id = a.client_id AND cr.staff_id = s.id AND cr.role IN ('HAUPTBEARBEITER', 'BERUFSTRAEGER'))
              -- redactSachverhalt zeigt nur nichtleere Bereiche. JS-Offsets zählen UTF-16-Codeeinheiten.
              OR CASE WHEN m.analysis_id = a.id AND m.verantwortlich_id = s.id AND m."end" > GREATEST(0, m.start)
                THEN CASE WHEN GREATEST(0, m.start) < char_length(a.source_text) THEN TRUE
                  ELSE GREATEST(0, m.start) < char_length(regexp_replace(a.source_text, U&'[\+010000-\+10FFFF]', 'xx', 'g')) END
                ELSE FALSE END
            )
          ))
        )
    )
$function$;
