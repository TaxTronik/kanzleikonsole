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
  DO $$
  DECLARE
    v_pw text := :'pw';
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxtronik_app') THEN
      EXECUTE format('CREATE ROLE taxtronik_app LOGIN PASSWORD %L', v_pw);
    ELSE
      EXECUTE format('ALTER ROLE taxtronik_app WITH PASSWORD %L', v_pw);
    END IF;
  END $$;

  -- Default-GRANTs für künftig angelegte Tabellen
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taxtronik_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO taxtronik_app;
  GRANT USAGE ON SCHEMA public TO taxtronik_app;

  -- App-Role darf KEINE Tabellen umgehen (BYPASSRLS bleibt absichtlich aus).
EOSQL

# n8n: eigene DB + User (nur produktiv aktiv; in dev nutzt n8n SQLite)
if [[ -n "${N8N_DB_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 \
       -v pw="$N8N_DB_PASSWORD" \
       --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    DO $$
    DECLARE
      v_pw text := :'pw';
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN
        EXECUTE format('CREATE ROLE n8n LOGIN PASSWORD %L', v_pw);
      ELSE
        EXECUTE format('ALTER ROLE n8n WITH PASSWORD %L', v_pw);
      END IF;
    END $$;
EOSQL

  # CREATE DATABASE muss außerhalb einer Transaktion laufen
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='n8n'" | grep -q 1 || \
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c \
      "CREATE DATABASE n8n OWNER n8n"
fi

echo "[postgres-init] OK."
