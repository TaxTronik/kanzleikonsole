-- ACCESS-SEARCH-SCOPE-001 / ACCESS-TENANT-RLS-001 / ACCESS-STAFF-PERMISSION-001 /
-- PORTAL-INBOX-SUBMISSION-001.
--
-- Verhaltensneutral für Treffer und Sichtbarkeit; Review-Finding P-10
-- (Folgepunkt Posteingangssuche).
--
-- Die Staff-Suche im Mandanten-Posteingang filtert tenantweit per ILIKE '%q%'
-- (Prisma `contains` + `insensitive`) über Betreff, Mandantenname, DATEV- und
-- Addison-Nummer. Unter RLS darf PostgreSQL ~~* nicht als Indexbedingung nutzen
-- (nicht LEAKPROOF, läuft nach den Policy-Bedingungen): Jede Thread-Zeile des
-- Tenants durchlief die Staff-Policy (app.portal_inbox_staff_access, rund
-- 0,5 ms je Zeile). Mit 100.000 Threads dauerte eine Suche rund 56 s je Abfrage
-- (Zählung und Seite). portal_inbox_thread_subject_trgm_idx blieb ungenutzt.
--
-- Zweistufige Suche:
--  1. app.portal_inbox_staff_search_candidates() sucht mit demselben Muster wie
--     Prisma `contains` (Begriff unverändert, LIKE-Metazeichen wirken wie dort)
--     über den Trigram-Index und liefert die IDs der Treffer im Tenant aus
--     app.current_tenant_id(). Geliefert werden nur Threads, die die
--     Staff-Policy der Tabelle (portal_inbox_thread_staff_select =
--     app.portal_inbox_staff_access) sichtbar macht: Deren Teilbedingungen
--     (Tenant des Kontexts, Akteur STAFF, PORTAL_INBOX_MANAGE) prüft die
--     Funktion einmal vorab, den Mandantenzugriff
--     (app.notification_staff_can_access_client, wie in der Policy) je Mandant
--     der Treffer. Ohne Kontext keine Zeile. Mehr als p_limit (höchstens
--     10.000) Treffer: eine Zeile ueberlauf = true, ohne IDs.
--  2. Die App lädt die Liste wie bisher unter RLS mit allen Filtern und
--     zusätzlich `id IN (Kandidaten)`; bei Überlauf ohne Vorauswahl wie bisher.
--     Da die Kandidaten alle sichtbaren Treffer enthalten, bleiben Treffer,
--     Zähler und Reihenfolge gleich.
--
-- SECURITY DEFINER, damit die Kandidatenabfrage ohne Policy-Barriere plant;
-- row_security = off lässt sie scheitern statt still gefiltert zu laufen, falls
-- der Owner RLS nicht umgehen darf. force_custom_plan plant jeden Aufruf mit
-- dem konkreten Suchmuster (Trigram-Selektivität). EXECUTE erhält die
-- App-Rolle und wie bei allen App-Funktionen taxtronik_owner (Parität,
-- 20261006160000_owner_role_least_privilege). Die Portalsuche (ein Mandant) und
-- die Dokumentseitensuche (ein Mandant, ein Ordner) laufen über ihre
-- Scope-Indizes und bleiben unverändert.
BEGIN;

CREATE FUNCTION app.portal_inbox_staff_search_candidates(p_query TEXT, p_limit INTEGER)
RETURNS TABLE (thread_id UUID, ueberlauf BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET plan_cache_mode = force_custom_plan
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

REVOKE ALL ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.portal_inbox_staff_search_candidates(TEXT, INTEGER) TO taxtronik_owner;

COMMIT;
