#!/bin/sh
# =============================================================================
# pg_dump via Postgres-Container — Host-Escape-Hatch fuer den Backup-Runner.
#
# Der Runner (apps/web/src/server/backup/runner.ts) spawn't pg_dump und liest
# den Dump-Strom von stdout. Auf einem Host OHNE postgresql-client (oder ohne
# zum Server passenden Client-Major) setzen wir PG_DUMP_PATH auf dieses Script.
# Es fuehrt pg_dump INNERHALB des Postgres-Containers aus — damit passt der
# Client-Major garantiert zum Server (hier: 18), und stdout/stderr/exit-code
# kommen korrekt zurueck. PGPASSWORD wird vom Runner im spawn-env gesetzt und
# hier an den Container durchgereicht (-i fuer binaren Stdout-Stream, kein -t).
#
# Wird automatisch durch ops-lib run_backup aktiviert, sobald `pg_dump` nicht
# im Host-PATH liegt.
#
# P3-2: PGPASSWORD als `-e PGPASSWORD` (ohne Wert) durchreichen — Docker liest
# den Wert aus dem Prozess-Env. `-e VAR=wert` legte das Passwort in die
# Container-argv (per `docker inspect`/`ps` lesbar).
# =============================================================================
set -eu
export PGPASSWORD="${PGPASSWORD:-}"
exec docker exec -i -e PGPASSWORD taxtronik-postgres pg_dump "$@"
