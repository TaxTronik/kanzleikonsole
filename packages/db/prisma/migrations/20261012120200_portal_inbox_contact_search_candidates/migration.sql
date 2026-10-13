-- ACCESS-SEARCH-SCOPE-001 / ACCESS-TENANT-RLS-001 / PORTAL-INBOX-SUBMISSION-001.
--
-- Review-Finding P-10, Folgepunkt Welle 15: Suche im Posteingang des
-- Mandantenportals.
--
-- Die Portalliste filterte den Suchbegriff per ILIKE '%q%' (Prisma `contains`
-- + `insensitive`) über Betreff und den eigenen Mandantennamen unter RLS. Der
-- Operator ist nicht LEAKPROOF; jede Thread-Zeile des Mandanten durchlief
-- deshalb zuerst die Kontakt-Policy (app.portal_inbox_contact_access, rund
-- 0,04 ms je Zeile). Ein Mandant mit 20.333 Threads brauchte allein für die
-- Zählung 0,7 bis 0,8 s, mit der Seite das Doppelte;
-- portal_inbox_thread_subject_trgm_idx blieb für das Portal ungenutzt.
--
-- Neu: app.portal_inbox_contact_search_candidates() liefert höchstens p_limit
-- (<= 1.000) Thread-IDs, die jüngsten zuerst (last_message_at DESC, id DESC),
-- und eine Zeile ueberlauf = true, wenn es mehr gibt:
--  - Tenant ausschließlich aus app.current_tenant_id(), Kontakt aus
--    app.current_actor_id() (nur Akteur CLIENT_CONTACT); der Mandant kommt
--    ausschließlich aus diesem Kontakt, nie aus einem Parameter;
--  - dieselben Bedingungen wie die Kontakt-Policy: aktiver Kontakt, aktives,
--    nicht beendetes und nicht anonymisiertes Mandat, Nachrichtenfach an;
--  - dieselben Suchfelder und dasselbe Muster wie die Portalliste (Betreff,
--    eigener Mandantenname; keine internen Kanzleikennungen) und dieselben
--    Filter Thema, Status und Zug.
-- Die App lädt nur diese IDs unter RLS mit dem unveränderten Filter; die
-- Zählung ist auf die Grenze begrenzt, bei Überlauf zeigt das Portal
-- „Mehr als N Treffer – Suche verfeinern“ (apps/web/src/server/inbox).
--
-- portal_inbox_thread_subject_trgm_idx bleibt: Die Staff-Suche
-- (app.portal_inbox_staff_search_candidates_v2) nutzt ihn, die Portalsuche
-- kann ihn für seltene Begriffe nutzen.
--
-- SECURITY DEFINER, damit die Kandidatenabfrage ohne Policy-Barriere plant;
-- row_security = off lässt sie scheitern statt still gefiltert zu laufen, falls
-- der Owner RLS nicht umgehen darf. force_custom_plan plant jeden Aufruf mit
-- dem konkreten Suchmuster. EXECUTE erhalten die App-Rolle und wie bei allen
-- App-Funktionen taxtronik_owner (Parität, 20261006160000).
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.portal_inbox_contact_search_candidates(text,text,text,text,int4).sql
BEGIN;

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

REVOKE ALL ON FUNCTION app.portal_inbox_contact_search_candidates(TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_inbox_contact_search_candidates(TEXT, TEXT, TEXT, TEXT, INTEGER) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.portal_inbox_contact_search_candidates(TEXT, TEXT, TEXT, TEXT, INTEGER) TO taxtronik_owner;

COMMIT;
