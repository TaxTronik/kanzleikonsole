-- =============================================================================
-- N-6: SECURITY DEFINER + SET search_path für die RLS-Helper-Funktionen.
--
-- Hintergrund: Postgres-Anti-Pattern. Eine SECURITY DEFINER-Funktion läuft als
-- die Owner-Rolle (`taxtronik`, BYPASSRLS!). Wenn der search_path nicht
-- explizit gepinnt ist, kann ein Angreifer mit CREATE-Recht im Public-Schema
-- namensgleiche Operatoren/Casts/Funktionen schadowen und beim Aufruf der
-- Helper Code mit Owner-Rechten ausführen. Aktuell wird nur current_setting
-- + UUID-Cast verwendet (beides aus pg_catalog) — robust, aber wer weiß wie
-- die Helper in einer späteren Migration erweitert werden. Defense in Depth.
--
-- Fix: `SET search_path = pg_catalog` zwingt alle ungenannten Identifier
-- auf das System-Catalog. Public-Schema ist außen vor.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v TEXT;
BEGIN
    v := current_setting('app.current_tenant_id', TRUE);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION app.current_actor_id() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    v TEXT;
BEGIN
    v := current_setting('app.current_actor_id', TRUE);
    IF v IS NULL OR v = '' THEN
        RETURN NULL;
    END IF;
    RETURN v::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION app.current_actor_type() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    RETURN current_setting('app.current_actor_type', TRUE);
END;
$$;
