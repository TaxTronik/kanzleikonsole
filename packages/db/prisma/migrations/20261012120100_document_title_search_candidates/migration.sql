-- ACCESS-TENANT-RLS-001 / ACCESS-CLIENT-MODE-001 / ACCESS-STAFF-PERMISSION-001.
--
-- Review-Finding P-10, Folgepunkt Welle 15: Titelsuche der Dokumentenseite
-- (/staff/documents, eine Ebene: Mandant oder Kanzlei-intern, ein Ordner,
-- aktiv oder gelöscht).
--
-- Die Seite filterte per ILIKE '%q%' (Prisma `contains` + `insensitive`) unter
-- RLS. Der Operator ist nicht LEAKPROOF; PostgreSQL wertet ihn erst nach den
-- Policy-Bedingungen aus und darf document_title_trgm_idx nicht nutzen. Jede
-- Suche las alle Zeilen der Ebene: 200.000 Dokumente im Tenant, 50.000 in der
-- Wurzel eines Mandanten, seltener Begriff: 92 ms (Bitmap-Scan über die
-- Ebene, 50.000 Zeilen verworfen).
--
-- Neu: app.document_title_search_candidates() liefert für genau diese Ebene
-- höchstens p_limit (<= 1.000) Dokument-IDs, die jüngsten zuerst (created_at
-- DESC, id DESC), und eine Zeile ueberlauf = true, wenn es mehr gibt:
--  - dasselbe Muster wie Prisma `contains` (LIKE-Metazeichen wirken wie dort),
--    über den Trigram-Index;
--  - Tenant ausschließlich aus app.current_tenant_id(), Akteur aus
--    app.current_actor_id(); nur aktive Kanzleipersonen des Tenants;
--  - Mandantenebene nur mit Mandantenzugriff
--    (app.notification_staff_can_access_client, wie canAccessClientTx);
--  - die Teilbedingungen der RESTRICTIVE-Policies auf document:
--    document_payroll_restriction (PAYROLL_MANAGE einmal je Aufruf) und
--    document_mandate_artifact_scope (app.mandate_artifact_document_allowed
--    nur für markierte Dokumente).
-- Die App lädt nur diese IDs unter RLS mit dem unveränderten Filter
-- (apps/web/src/server/documents/title-search.ts); Treffer, Reihenfolge und
-- Gesamtzahl bleiben gleich.
--
-- SECURITY DEFINER, damit die Kandidatenabfrage ohne Policy-Barriere plant;
-- row_security = off lässt sie scheitern statt still gefiltert zu laufen, falls
-- der Owner RLS nicht umgehen darf. force_custom_plan plant jeden Aufruf mit
-- dem konkreten Suchmuster und Scope. EXECUTE erhalten die App-Rolle und wie
-- bei allen App-Funktionen taxtronik_owner (Parität, 20261006160000).
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.document_title_search_candidates(uuid,uuid,bool,text,int4).sql
BEGIN;

CREATE OR REPLACE FUNCTION app.document_title_search_candidates(p_client_id uuid, p_folder_id uuid, p_deleted boolean, p_query text, p_limit integer)
 RETURNS TABLE(document_id uuid, ueberlauf boolean)
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
  v_payroll BOOLEAN;
  v_treffer UUID[];
BEGIN
  -- Nur aktive Kanzleipersonen des Tenants aus dem Kontext; Tenant und Akteur
  -- kommen nie aus Parametern.
  IF v_tenant_id IS NULL
     OR p_query IS NULL
     OR p_deleted IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR NOT EXISTS (
       SELECT 1
         FROM public.staff_user staff
        WHERE staff.id = v_actor_id
          AND staff.tenant_id = v_tenant_id
          AND staff.active
     ) THEN
    RETURN;
  END IF;
  -- Mandantenscope: dieselbe Zugriffsentscheidung wie canAccessClientTx
  -- (ADMIN/PARTNER, OPEN ohne Vertraulichkeit, sonst Zuständigkeit).
  IF p_client_id IS NOT NULL
     AND NOT app.notification_staff_can_access_client(v_tenant_id, v_actor_id, p_client_id) THEN
    RETURN;
  END IF;
  -- RESTRICTIVE-Policy document_payroll_restriction für Kanzleipersonen: einmal
  -- je Aufruf statt je Zeile.
  v_payroll := app.expansion_staff_permission(v_tenant_id, v_actor_id, 'PAYROLL_MANAGE');
  -- Dasselbe Muster wie Prisma `contains` mit `insensitive`: der Begriff steht
  -- unverändert darin, LIKE-Metazeichen wirken wie in der Listenabfrage.
  v_pattern := '%' || p_query || '%';

  SELECT array_agg(geordnet.id ORDER BY geordnet.created_at DESC, geordnet.id DESC)
    INTO v_treffer
    FROM (
      SELECT doc.id, doc.created_at
        FROM public.document doc
       WHERE doc.tenant_id = v_tenant_id
         AND ((p_client_id IS NULL AND doc.client_id IS NULL) OR doc.client_id = p_client_id)
         AND ((p_folder_id IS NULL AND doc.folder_id IS NULL) OR doc.folder_id = p_folder_id)
         AND ((p_deleted AND doc.deleted_at IS NOT NULL) OR (NOT p_deleted AND doc.deleted_at IS NULL))
         AND doc.title ILIKE v_pattern
         -- Teilbedingungen der RESTRICTIVE-Policies document_payroll_restriction
         -- und document_mandate_artifact_scope.
         AND (NOT doc.requires_payroll_access OR v_payroll)
         AND (NOT doc.has_mandate_artifact
           OR app.mandate_artifact_document_allowed(doc.tenant_id, doc.id::text))
       ORDER BY doc.created_at DESC, doc.id DESC
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

REVOKE ALL ON FUNCTION app.document_title_search_candidates(UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.document_title_search_candidates(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.document_title_search_candidates(UUID, UUID, BOOLEAN, TEXT, INTEGER) TO taxtronik_owner;

COMMIT;
