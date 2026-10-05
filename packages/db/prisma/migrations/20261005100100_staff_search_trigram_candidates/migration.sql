-- ACCESS-SEARCH-SCOPE-001 / ACCESS-TENANT-RLS-001 / ACCESS-CLIENT-MODE-001.
--
-- Verhaltensneutral für Treffer und Sichtbarkeit; Review-Finding P-10.
--
-- Die globale Kanzleisuche (/api/staff/search) filtert per ILIKE '%q%'
-- (Prisma `contains` + `insensitive`). Unter RLS darf PostgreSQL diesen
-- Operator nicht als Indexbedingung nutzen: ~~* ist nicht LEAKPROOF und wird
-- erst NACH den Policy-Bedingungen ausgewertet. Die pg_trgm-GIN-Indizes aus
-- 20260721000000_iter71_search_trgm_indexes blieben deshalb ungenutzt; die
-- Dokumentsuche las jede Tenant-Zeile und rief dabei je Zeile die
-- Policy-Funktionen auf (200.000 Dokumente: rund 2 s je Anfrage).
--
-- Zweistufige Suche:
--  1. app.staff_search_candidates() liefert für EINE Kategorie höchstens
--     p_limit (<= 200) Kandidaten-IDs ab p_offset (<= 1000) über die
--     Trigram-Indizes, sortiert wie die Trefferliste. Der Tenant kommt
--     AUSSCHLIESSLICH aus app.current_tenant_id() (Transaktionskontext, nie aus
--     einem Parameter); ohne Kontext gibt es keine Zeile. Die Funktion liefert
--     nur IDs eigener Tenant-Zeilen, keine Inhalte.
--  2. Die App lädt danach nur diese IDs unter RLS (Primärschlüssel, LEAKPROOF)
--     mit den normalen Zugriffsfiltern (Mandantenpolicy, Dokument-Policies,
--     Modul-Gates) und demselben Suchfilter; reichen die sichtbaren Treffer
--     nicht, holt sie den nächsten Kandidatenblock (begrenzte Rundenzahl).
--     Was die zweite Stufe nicht sieht, erscheint nicht.
--
-- SECURITY DEFINER, damit die Kandidatenabfrage ohne Policy-Barriere plant;
-- row_security = off lässt sie scheitern statt still gefiltert zu laufen, falls
-- der Owner RLS nicht umgehen darf. force_custom_plan plant jeden Aufruf mit dem
-- konkreten Suchmuster (Trigram-Selektivität). EXECUTE erhält nur die App-Rolle.
BEGIN;

CREATE FUNCTION app.staff_search_candidates(
  p_kind TEXT,
  p_term TEXT,
  p_limit INTEGER,
  p_offset INTEGER
)
RETURNS TABLE (candidate_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = off
SET plan_cache_mode = force_custom_plan
AS $$
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
$$;

REVOKE ALL ON FUNCTION app.staff_search_candidates(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.staff_search_candidates(TEXT, TEXT, INTEGER, INTEGER) TO taxtronik_app;

COMMIT;
