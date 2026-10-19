#!/usr/bin/env bash
# =============================================================================
# Postgres — Teil der Operator-CLI (./taxtronik).
#
# Warten auf einen gesunden Postgres-Container und Synchronisierung der
# Rollenpasswoerter aus .env (inklusive Owner- und Drill-Rolle, S-01).
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

# ---------------------------------------------------------------------------
# Hilfs-Ablaeufe fuer Initial-Deploy / rollback
# ---------------------------------------------------------------------------
wait_postgres_healthy() {
  info "Warten bis Postgres healthy ist"
  local deadline=$(( $(date +%s) + 120 )) s
  while :; do
    [[ $(date +%s) -ge $deadline ]] && die "Postgres nach 120 s nicht healthy."
    s="$(docker inspect --format '{{.State.Health.Status}}' taxtronik-postgres 2>/dev/null || true)"
    [[ "$s" == "healthy" ]] && { info "Postgres healthy."; return 0; }
    sleep 2
  done
}

sql_literal() {
  local value
  value="$(printf '%s' "$1" | sed "s/'/''/g")"
  printf "'%s'" "$value"
}

# Idempotentes CREATE/ALTER einer Login-Rolle mit festen Attributen. Das
# Passwort steht nur als SQL-Literal im stdin von psql, nie in Argumenten.
_sync_login_role_sql() {
  local role="$1" attributes="$2" password_literal="$3"
  printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN EXECUTE format('ALTER ROLE %s WITH LOGIN %s PASSWORD %%L', %s); ELSE EXECUTE format('CREATE ROLE %s LOGIN %s PASSWORD %%L', %s); END IF; END \$\$;\n" \
    "$role" "$role" "$attributes" "$password_literal" "$role" "$attributes" "$password_literal"
}

sync_postgres_roles_from_env() {
  require_cmd docker
  require_env POSTGRES_PASSWORD TAXTRONIK_APP_PASSWORD TAXTRONIK_OWNER_PASSWORD \
    TAXTRONIK_DRILL_PASSWORD N8N_DB_PASSWORD
  local pg_pw app_pw owner_pw drill_pw n8n_pw
  pg_pw="$(sql_literal "$POSTGRES_PASSWORD")"
  app_pw="$(sql_literal "$TAXTRONIK_APP_PASSWORD")"
  owner_pw="$(sql_literal "$TAXTRONIK_OWNER_PASSWORD")"
  drill_pw="$(sql_literal "$TAXTRONIK_DRILL_PASSWORD")"
  n8n_pw="$(sql_literal "$N8N_DB_PASSWORD")"

  info "Postgres-Rollenpasswoerter mit .env synchronisieren"
  {
    printf 'ALTER ROLE taxtronik WITH PASSWORD %s;\n' "$pg_pw"
    _sync_login_role_sql taxtronik_app \
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" "$app_pw"
    # S-01: Owner-Verbindung von app/worker. BYPASSRLS wie bisher, aber kein
    # Superuser; Grants vergibt die Migration 20261006160000.
    _sync_login_role_sql taxtronik_owner \
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS" "$owner_pw"
    # S-01: Restore-Drill des Workers: nur eigene Wegwerf-DBs (CREATEDB).
    _sync_login_role_sql taxtronik_drill \
      "NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS" "$drill_pw"
    printf "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n') THEN EXECUTE format('ALTER ROLE n8n WITH PASSWORD %%L', %s); END IF; END \$\$;\n" "$n8n_pw"
  } | docker exec -i taxtronik-postgres psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1
}

# TCMS Stufe 2 (Restore): Rollen der TCMS-Datenbank vor pg_restore aus .env
# anlegen bzw. angleichen, Attribute wie 01_bootstrap.sql des TCMS-Repos
# (tcms_owner ohne BYPASSRLS, tcms_app zusaetzlich NOINHERIT und nie Mitglied
# von tcms_owner). Passwoerter nur als SQL-Literal im stdin von psql. Rechte
# und Pruefung stellt danach der Migrationsschritt tcms-migrate her.
sync_tcms_roles_from_env() {
  require_env TCMS_DB_OWNER_PASSWORD TCMS_DB_APP_PASSWORD
  local owner_pw app_pw
  owner_pw="$(sql_literal "$TCMS_DB_OWNER_PASSWORD")"
  app_pw="$(sql_literal "$TCMS_DB_APP_PASSWORD")"
  info "TCMS-Rollen tcms_owner/tcms_app aus .env angleichen"
  {
    _sync_login_role_sql tcms_owner \
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS" "$owner_pw"
    _sync_login_role_sql tcms_app \
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT" "$app_pw"
    printf "DO \$\$ BEGIN IF pg_catalog.pg_has_role('tcms_app', 'tcms_owner', 'MEMBER') THEN REVOKE tcms_owner FROM tcms_app; END IF; END \$\$;\n"
  } | docker exec -i "$TCMS_DB_CONTAINER" psql -X -q -U tcms -d postgres -v ON_ERROR_STOP=1
}
