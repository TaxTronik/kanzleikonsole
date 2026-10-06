CREATE OR REPLACE FUNCTION app.staff_search_candidates(p_kind text, p_term text, p_limit integer, p_offset integer)
 RETURNS TABLE(candidate_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INTEGER := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 1000);
  v_pattern TEXT;
BEGIN
  IF v_tenant_id IS NULL OR p_term IS NULL THEN
    RETURN;
  END IF;
  -- Teilstringsuche wie Prisma `contains`: LIKE-Metazeichen wörtlich; ein
  -- leerer Begriff trifft wie dort alles.
  v_pattern := '%' || replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  CASE p_kind
    WHEN 'client' THEN
      RETURN QUERY
        SELECT c.id
          FROM public.client c
         WHERE c.tenant_id = v_tenant_id
           AND (c.name ILIKE v_pattern OR c.datev_no ILIKE v_pattern
             OR c.addison_no ILIKE v_pattern OR c.vat_id ILIKE v_pattern)
         ORDER BY c.name, c.id
         LIMIT v_limit OFFSET v_offset;
    WHEN 'request' THEN
      RETURN QUERY
        SELECT r.id
          FROM public.request r
         WHERE r.tenant_id = v_tenant_id
           AND (r.title ILIKE v_pattern OR r.description ILIKE v_pattern)
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT v_limit OFFSET v_offset;
    WHEN 'document' THEN
      RETURN QUERY
        SELECT d.id
          FROM public.document d
         WHERE d.tenant_id = v_tenant_id
           AND d.deleted_at IS NULL
           AND d.title ILIKE v_pattern
         ORDER BY d.created_at DESC, d.id DESC
         LIMIT v_limit OFFSET v_offset;
    WHEN 'invoice' THEN
      RETURN QUERY
        SELECT i.id
          FROM public.invoice i
         WHERE i.tenant_id = v_tenant_id
           AND (i.number ILIKE v_pattern OR i.subject ILIKE v_pattern)
         ORDER BY i.issue_date DESC, i.id DESC
         LIMIT v_limit OFFSET v_offset;
    ELSE
      RETURN;
  END CASE;
END;
$function$;
