#!/usr/bin/env bash
# =============================================================================
# pg_restore via Postgres-Container — Host-Escape-Hatch fuer den Restore-Runner.
#
# Symmetrisch zu pg_dump-via-container.sh: Wenn auf dem Host kein passender
# postgresql-client installiert ist, fuehrt restore.ts pg_restore im laufenden
# Postgres-Container aus. PGPASSWORD wird vom Runner gesetzt und durchgereicht.
#
# restore.ts legt S3-Downloads als Host-Tempdatei ab. Diese Datei ist im
# Container nicht sichtbar, daher wird der letzte argv-Wert (Dump-Datei) hier
# entfernt und via stdin in pg_restore gestreamt. pg_restore liest Custom-Dumps
# ohne Dateinamen von stdin.
# =============================================================================
set -euo pipefail

argc=$#
if [ "$argc" -gt 0 ]; then
  eval "dump_file=\${$argc}"
  if [ -f "$dump_file" ]; then
    set -- "${@:1:$(($argc - 1))}"
    exec docker exec -i -e PGPASSWORD="${PGPASSWORD:-}" taxtronik-postgres pg_restore "$@" < "$dump_file"
  fi
fi

exec docker exec -i -e PGPASSWORD="${PGPASSWORD:-}" taxtronik-postgres pg_restore "$@"
