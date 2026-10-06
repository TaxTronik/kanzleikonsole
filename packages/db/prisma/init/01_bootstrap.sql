-- =============================================================================
-- DB-Bootstrap für CI / Test-Umgebungen.
--
-- Der CI-Postgres-Service ist ein nacktes Image OHNE das produktive
-- infra/scripts/postgres-init.sh. Die init-Migration (20260510000000_init)
-- referenziert aber die Rolle `taxtronik_app` (RLS-Backstop) — ohne sie
-- scheitert `prisma migrate deploy` mit „role taxtronik_app does not exist".
--
-- Diese Datei legt Rolle + Extensions idempotent an. Passwort ist fix
-- `taxtronik_app` und MUSS zur DATABASE_APP_URL in .forgejo/workflows/ci.yml
-- passen (postgresql://taxtronik_app:taxtronik_app@localhost:5432/taxtronik).
--
-- S-01: Owner-Verbindung der Container (`taxtronik_owner`, BYPASSRLS ohne
-- Superuser) und Restore-Drill-Rolle (`taxtronik_drill`, CREATEDB für die
-- Wegwerf-DB) mit fixen Testpasswörtern = Rollenname. Grants vergibt die
-- Migration 20261006160000_owner_role_least_privilege; sie legt die
-- Owner-Rolle notfalls selbst NOLOGIN an.
--
-- NICHT für Produktion — dort macht infra/scripts/postgres-init.sh das mit
-- einem zufälligen Passwort aus der .env.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app') THEN
    CREATE ROLE taxtronik_app LOGIN PASSWORD 'taxtronik_app';
  ELSE
    ALTER ROLE taxtronik_app WITH PASSWORD 'taxtronik_app';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_owner') THEN
    CREATE ROLE taxtronik_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      BYPASSRLS PASSWORD 'taxtronik_owner';
  ELSE
    ALTER ROLE taxtronik_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      BYPASSRLS PASSWORD 'taxtronik_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_drill') THEN
    CREATE ROLE taxtronik_drill LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION
      BYPASSRLS PASSWORD 'taxtronik_drill';
  ELSE
    ALTER ROLE taxtronik_drill WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION
      BYPASSRLS PASSWORD 'taxtronik_drill';
  END IF;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taxtronik_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taxtronik_app;
GRANT USAGE ON SCHEMA public TO taxtronik_app;
