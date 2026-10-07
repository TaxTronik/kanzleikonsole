#!/bin/bash
# =============================================================================
# taxtronik — Postgres-Initialisierung
#
# Läuft EINMAL beim ersten Start des Postgres-Containers (über das offizielle
# docker-entrypoint-initdb.d-Verfahren). Benötigte Umgebungsvariablen:
#
#   POSTGRES_USER          (default: 'taxtronik', vom docker-Image gesetzt)
#   POSTGRES_DB            (default: 'taxtronik')
#   TAXTRONIK_APP_PASSWORD  — Passwort für die eingeschränkte App-Rolle
#   TAXTRONIK_OWNER_PASSWORD — Owner-Verbindung von app/worker (S-01), optional
#   TAXTRONIK_DRILL_PASSWORD — Restore-Drill-Rolle des Workers (S-01), optional
#   N8N_DB_PASSWORD        — Passwort für n8n's eigene DB (nur produktiv aktiv)
#
# Werte werden vom Setup-Skript zufällig generiert und in `.env` persistiert.
#
# P-1: Passwort-Werte werden NIE per Bash-Interpolation in den Heredoc gebaut
# (das wäre SQL-Injection durch Admin-Input). Stattdessen wird die psql-
# Variable `:'pw'` per `-v pw=...` übergeben und in `EXECUTE format(..., %L)`
# sicher gequotet. Der Heredoc selbst ist mit single-quoted-Delimiter
# (`<<-'EOSQL'`) abgeschirmt, sodass Bash $-Expansion gar nicht stattfindet.
# =============================================================================

set -euo pipefail

if [[ -z "${TAXTRONIK_APP_PASSWORD:-}" ]]; then
  echo "[postgres-init] FATAL: TAXTRONIK_APP_PASSWORD nicht gesetzt." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     -v pw="$TAXTRONIK_APP_PASSWORD" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
  -- Extensions
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid(), digest()
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- Volltext-/Trigram-Suche (KB)
  CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive E-Mail-Spalten

  -- Eingeschränkte Application-Role (RLS-Backstop). Passwort via psql-Variable
  -- (siehe P-1): format(..., %L) macht das SQL-quoting + escape sicher.
  -- psql-Variablen werden NICHT in $$-quoted PL/pgSQL-Blöcke interpoliert,
  -- daher Idempotenz hier über \gexec auf zwei SELECT-Zweige.
  SELECT format('CREATE ROLE taxtronik_app LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app')
  \gexec
  SELECT format('ALTER ROLE taxtronik_app WITH PASSWORD %L', :'pw')
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app')
  \gexec

  -- Default-GRANTs für künftig angelegte Tabellen
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taxtronik_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO taxtronik_app;
  GRANT USAGE ON SCHEMA public TO taxtronik_app;

  -- App-Role darf KEINE Tabellen umgehen (BYPASSRLS bleibt absichtlich aus).
EOSQL

# S-01: Die Owner-Verbindung der Container app/worker ist NICHT der Superuser.
# taxtronik_owner umgeht RLS (BYPASSRLS), darf aber nur Daten lesen/schreiben;
# die Grants vergibt die Migration 20261006160000_owner_role_least_privilege.
# taxtronik_drill legt fuer den monatlichen Restore-Drill des Workers eine
# Wegwerf-DB an (CREATEDB) und hat in der Produktiv-DB keine Rechte. Ohne
# Passwort entsteht hier keine Rolle: ./taxtronik setzt Rolle, LOGIN und
# Passwort vor jedem Start (sync_postgres_roles_from_env), die Migration legt
# die Owner-Rolle notfalls ohne LOGIN an.
if [[ -n "${TAXTRONIK_OWNER_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 \
       -v pw="$TAXTRONIK_OWNER_PASSWORD" \
       --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT format('CREATE ROLE taxtronik_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', :'pw')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_owner')
    \gexec
    SELECT format('ALTER ROLE taxtronik_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', :'pw')
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_owner')
    \gexec
EOSQL
fi

if [[ -n "${TAXTRONIK_DRILL_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 \
       -v pw="$TAXTRONIK_DRILL_PASSWORD" \
       --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT format('CREATE ROLE taxtronik_drill LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', :'pw')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_drill')
    \gexec
    SELECT format('ALTER ROLE taxtronik_drill WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD %L', :'pw')
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_drill')
    \gexec
EOSQL
fi

# F-06: pg_stat_statements (geladen per shared_preload_libraries in
# docker-compose.yml) in der Wartungs-DB `postgres`. Die Statistik ist
# clusterweit, die Spalte dbid trennt die Datenbanken. Bewusst NICHT in der
# App-Datenbank: die Extension ist nicht "trusted" — der Restore-Drill
# (taxtronik_drill, kein Superuser) könnte einen Dump mit ihr nicht einspielen —
# und sie gäbe ihre Views per GRANT an PUBLIC frei, also auch an taxtronik_app.
# Hier lesen nur Superuser und Mitglieder von pg_read_all_stats (pg_monitor).
# Ein Fehler stoppt die Initialisierung nicht: die Statistik ist Diagnose,
# kein Betriebsbestandteil.
if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-'EOSQL'
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  REVOKE ALL ON pg_stat_statements, pg_stat_statements_info FROM PUBLIC;
  GRANT SELECT ON pg_stat_statements, pg_stat_statements_info TO pg_read_all_stats;
EOSQL
then
  echo "[postgres-init] WARNUNG: pg_stat_statements nicht angelegt (siehe docs/operations/day-2-operations.md)." >&2
fi

# n8n: eigene DB + User (nur produktiv aktiv; in dev nutzt n8n SQLite)
if [[ -n "${N8N_DB_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 \
       -v pw="$N8N_DB_PASSWORD" \
       --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT format('CREATE ROLE n8n LOGIN PASSWORD %L', :'pw')
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n')
    \gexec
    SELECT format('ALTER ROLE n8n WITH PASSWORD %L', :'pw')
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n')
    \gexec
EOSQL

  # CREATE DATABASE muss außerhalb einer Transaktion laufen
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='n8n'" | grep -q 1 || \
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c \
      "CREATE DATABASE n8n OWNER n8n"
fi

echo "[postgres-init] OK."
