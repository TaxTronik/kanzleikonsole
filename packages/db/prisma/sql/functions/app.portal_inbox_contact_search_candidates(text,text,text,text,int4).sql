CREATE OR REPLACE FUNCTION app.portal_inbox_contact_search_candidates(p_query text, p_topic text, p_status text, p_attention text, p_limit integer)
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
  v_client_id UUID;
  v_client_name TEXT;
  v_pattern TEXT;
  v_treffer UUID[];
BEGIN
  IF v_tenant_id IS NULL
     OR p_query IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT' THEN
    RETURN;
  END IF;
  -- Mandant ausschließlich über den Kontakt aus dem Kontext, mit denselben
  -- Bedingungen wie app.portal_inbox_contact_access (Policy
  -- portal_inbox_thread_contact_select): aktiver Kontakt, aktives, nicht
  -- beendetes und nicht anonymisiertes Mandat, Nachrichtenfach eingeschaltet.
  SELECT contact.client_id, client.name
    INTO v_client_id, v_client_name
    FROM public.client_contact contact
    JOIN public.client client
      ON client.id = contact.client_id
     AND client.tenant_id = contact.tenant_id
    JOIN public.tenant_setting setting
      ON setting.tenant_id = contact.tenant_id
     AND setting.key = 'portal.features'
   WHERE contact.id = v_actor_id
     AND contact.tenant_id = v_tenant_id
     AND contact.active
     AND client.allow_active
     AND client.mandate_ended_at IS NULL
     AND client.anonymized_at IS NULL
     AND setting.value ->> 'clientInbox' = 'true';
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;
  -- Dasselbe Muster wie Prisma `contains` mit `insensitive`: der Begriff steht
  -- unverändert darin, LIKE-Metazeichen wirken wie in der Listenabfrage.
  v_pattern := '%' || p_query || '%';

  -- Suchfelder des Portals (inboxMetadataSearch(query, 'portal')): Betreff und
  -- der eigene Mandantenname, der dann alle Threads trifft. Keine internen
  -- Kanzleikennungen.
  SELECT array_agg(geordnet.id ORDER BY geordnet.last_message_at DESC, geordnet.id DESC)
    INTO v_treffer
    FROM (
      SELECT thread.id, thread.last_message_at
        FROM public.portal_inbox_thread thread
       WHERE thread.tenant_id = v_tenant_id
         AND thread.client_id = v_client_id
         AND (v_client_name ILIKE v_pattern OR thread.subject ILIKE v_pattern)
         AND (p_topic IS NULL OR thread.topic::text = p_topic)
         AND (p_status IS NULL OR thread.status::text = p_status)
         AND (p_attention IS NULL OR thread.attention::text = p_attention)
       ORDER BY thread.last_message_at DESC, thread.id DESC
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
