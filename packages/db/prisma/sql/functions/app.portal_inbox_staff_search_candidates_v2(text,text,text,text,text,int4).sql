CREATE OR REPLACE FUNCTION app.portal_inbox_staff_search_candidates_v2(p_query text, p_topic text, p_status text, p_attention text, p_scope text, p_limit integer)
 RETURNS TABLE(thread_id uuid, ueberlauf boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_actor_id UUID := app.current_actor_id();
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000);
  v_pattern TEXT;
  v_treffer UUID[];
BEGIN
  -- Teilbedingungen von app.portal_inbox_staff_access, die nicht vom Mandanten
  -- abhängen: Tenant des Kontexts, Kanzleiperson, Posteingangsrecht. Der
  -- Bearbeiter für „Meine Arbeit“ kommt wie der Tenant nur aus dem Kontext.
  IF v_tenant_id IS NULL
     OR p_query IS NULL
     OR p_scope IS NULL
     OR p_scope NOT IN ('mine', 'team', 'all')
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR NOT app.expansion_staff_permission(v_tenant_id, v_actor_id, 'PORTAL_INBOX_MANAGE') THEN
    RETURN;
  END IF;
  -- Dasselbe Muster wie Prisma `contains` mit `insensitive`: der Begriff steht
  -- unverändert darin, LIKE-Metazeichen wirken wie in der Listenabfrage.
  v_pattern := '%' || p_query || '%';

  -- Alle Treffer derselben Felder und Filter wie die Staff-Liste
  -- (inboxMetadataSearch, Thema, Status, Zug, Arbeitsbereich), über den
  -- Betreff-Trigramindex beziehungsweise die Mandanten-Trigramindizes.
  WITH treffer AS MATERIALIZED (
    SELECT thread.id, thread.client_id, thread.last_message_at
      FROM public.portal_inbox_thread thread
     WHERE thread.tenant_id = v_tenant_id
       AND thread.subject ILIKE v_pattern
       AND (p_topic IS NULL OR thread.topic::text = p_topic)
       AND (p_status IS NULL OR thread.status::text = p_status)
       AND (p_attention IS NULL OR thread.attention::text = p_attention)
       AND (p_scope = 'all'
         OR (p_scope = 'mine' AND thread.assigned_staff_id = v_actor_id)
         OR (p_scope = 'team' AND thread.assigned_staff_id IS NULL))
    UNION
    SELECT thread.id, thread.client_id, thread.last_message_at
      FROM public.client client
      JOIN public.portal_inbox_thread thread
        ON thread.tenant_id = client.tenant_id
       AND thread.client_id = client.id
     WHERE client.tenant_id = v_tenant_id
       AND (client.name ILIKE v_pattern
         OR client.datev_no ILIKE v_pattern
         OR client.addison_no ILIKE v_pattern)
       AND (p_topic IS NULL OR thread.topic::text = p_topic)
       AND (p_status IS NULL OR thread.status::text = p_status)
       AND (p_attention IS NULL OR thread.attention::text = p_attention)
       AND (p_scope = 'all'
         OR (p_scope = 'mine' AND thread.assigned_staff_id = v_actor_id)
         OR (p_scope = 'team' AND thread.assigned_staff_id IS NULL))
  ),
  -- Eigene materialisierte Stufe: Sonst schiebt der Planer die
  -- Zugriffsfunktion unter das DISTINCT und ruft sie je Thread auf.
  kandidat AS MATERIALIZED (
    SELECT DISTINCT treffer.client_id FROM treffer
  ),
  -- Restliche Teilbedingung der Staff-Policy (Mandantenzugriff wie in
  -- app.portal_inbox_staff_access) und der Mandatsstatus der Liste, je Mandant
  -- der Treffer einmal ausgewertet statt je Thread.
  mandant AS MATERIALIZED (
    SELECT kandidat.client_id
      FROM kandidat
      JOIN public.client client
        ON client.tenant_id = v_tenant_id
       AND client.id = kandidat.client_id
     WHERE client.allow_active
       AND client.anonymized_at IS NULL
       AND client.mandate_ended_at IS NULL
       AND app.notification_staff_can_access_client(v_tenant_id, v_actor_id, kandidat.client_id)
  )
  SELECT array_agg(geordnet.id ORDER BY geordnet.last_message_at DESC, geordnet.id DESC)
    INTO v_treffer
    FROM (
      SELECT treffer.id, treffer.last_message_at
        FROM treffer
        JOIN mandant ON mandant.client_id = treffer.client_id
       ORDER BY treffer.last_message_at DESC, treffer.id DESC
       LIMIT v_limit + 1
    ) AS geordnet;

  -- Die jüngsten v_limit Treffer in Listenreihenfolge; gibt es mehr, folgt
  -- eine Zeile ueberlauf = true ohne ID.
  RETURN QUERY
    SELECT kandidat.id, FALSE
      FROM unnest(v_treffer[1:v_limit]) WITH ORDINALITY AS kandidat(id, rang)
     ORDER BY kandidat.rang;
  IF COALESCE(cardinality(v_treffer), 0) > v_limit THEN
    RETURN QUERY SELECT NULL::UUID, TRUE;
  END IF;
END;
$function$;
