CREATE OR REPLACE FUNCTION app.portal_inbox_staff_search_candidates(p_query text, p_limit integer)
 RETURNS TABLE(thread_id uuid, ueberlauf boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 10000);
  v_pattern TEXT;
  v_treffer UUID[];
BEGIN
  -- Teilbedingungen von app.portal_inbox_staff_access, die nicht vom Mandanten
  -- abhängen: Tenant des Kontexts, Kanzleiperson, Posteingangsrecht.
  IF v_tenant_id IS NULL
     OR p_query IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR NOT app.expansion_staff_permission(v_tenant_id, app.current_actor_id(), 'PORTAL_INBOX_MANAGE') THEN
    RETURN;
  END IF;
  -- Dasselbe Muster wie Prisma `contains` mit `insensitive`: der Begriff steht
  -- unverändert darin, LIKE-Metazeichen wirken wie in der bisherigen Abfrage.
  v_pattern := '%' || p_query || '%';

  SELECT array_agg(treffer.id) INTO v_treffer
    FROM (
      SELECT thread.id
        FROM public.portal_inbox_thread thread
       WHERE thread.tenant_id = v_tenant_id
         AND thread.subject ILIKE v_pattern
      UNION
      SELECT thread.id
        FROM public.client client
        JOIN public.portal_inbox_thread thread
          ON thread.tenant_id = client.tenant_id
         AND thread.client_id = client.id
       WHERE client.tenant_id = v_tenant_id
         AND (client.name ILIKE v_pattern
           OR client.datev_no ILIKE v_pattern
           OR client.addison_no ILIKE v_pattern)
       LIMIT v_limit + 1
    ) AS treffer;

  IF COALESCE(cardinality(v_treffer), 0) > v_limit THEN
    RETURN QUERY SELECT NULL::UUID, TRUE;
    RETURN;
  END IF;

  -- Restliche Teilbedingung von app.portal_inbox_staff_access (Policy
  -- portal_inbox_thread_staff_select): Mandantenzugriff, je Mandant der Treffer
  -- einmal ausgewertet. Geliefert werden damit nur Threads, die RLS ohnehin
  -- sichtbar macht.
  RETURN QUERY
    WITH kandidat AS MATERIALIZED (
      SELECT thread.id, thread.client_id
        FROM public.portal_inbox_thread thread
       WHERE thread.tenant_id = v_tenant_id
         AND thread.id = ANY (v_treffer)
    ),
    sichtbar AS MATERIALIZED (
      SELECT mandant.client_id
        FROM (SELECT DISTINCT kandidat.client_id FROM kandidat) AS mandant
       WHERE app.notification_staff_can_access_client(
               v_tenant_id,
               app.current_actor_id(),
               mandant.client_id
             )
    )
    SELECT kandidat.id, FALSE
      FROM kandidat
      JOIN sichtbar ON sichtbar.client_id = kandidat.client_id;
END;
$function$;
