#!/usr/bin/env bash
# =============================================================================
# Release- und Migrationszustand — Teil der Operator-CLI (./taxtronik).
#
# STATE, Migrations-Pending- und DB-Restore-Marker, zentraler Writer-Start-Guard,
# GwG-Invarianten-Gate, Migrationslauf und Finalisierung des Last-Good-Vertrags.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

run_migrations() {
  # One-Shot-Container statt Host-Prisma: das Worker-Image enthaelt Prisma-CLI
  # + Migrationen. Der Server braucht fuer Migrationen weder node_modules noch
  # einen publizierten Postgres-Port.
  local gwg_status=0
  begin_migration_transition
  info "DB-Migrationen anwenden (migrate-Container)"
  compose run --rm migrate
  database_has_gwg_invariants_for_checkout || gwg_status=$?
  case "$gwg_status" in
    0) ;;
    2) die "DB-Migrationen sind journalisiert, aber der GwG-Datenbankschutz konnte wegen eines SQL-/Verbindungsfehlers nicht geprueft werden (siehe oben); neue Writer werden nicht aktiviert." ;;
    *) die "DB-Migrationen sind journalisiert, aber der GwG-Datenbankschutz ist unvollstaendig; neue Writer werden nicht aktiviert." ;;
  esac
}

backup_before_migrations() {
  # Sicherheitsnetz vor migrate deploy (Prisma ist forward-only). Erst ab dem
  # zweiten Deploy sinnvoll — beim Erstdeploy existiert noch kein Schema.
  local migrated
  migrated="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -tAc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL" 2>/dev/null || true)"
  if [[ "$migrated" == "t" ]]; then run_backup
  else info "Erstdeploy erkannt (keine _prisma_migrations) — Backup vor Migration entfaellt."; fi
}

state_value() {
  local key="$1"
  [[ -f "$STATE" ]] || return 0
  grep -E "^${key}=" "$STATE" | head -n1 | cut -d= -f2- || true
}

pending_migration_value() {
  local key="$1"
  [[ -f "$MIGRATION_PENDING" ]] || return 0
  grep -E "^${key}=" "$MIGRATION_PENDING" | head -n1 | cut -d= -f2- || true
}

# Ermittelt am echten DB-Migrationsjournal, ob `migrate deploy` mindestens eine
# Migration anwenden wird. Jeder Probe-Fehler wird als unknown behandelt; ein
# Rollback darf dann später nicht optimistisch alten Code starten.
pending_database_migration_requirement() {
  local applied migration name query_out
  query_out="$(compose --infra exec -T postgres psql -U taxtronik -d taxtronik -Atc \
    'SELECT migration_name FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' \
    2>/dev/null)" || { printf 'unknown'; return 0; }
  applied=$'\n'"$query_out"$'\n'
  for migration in "$ROOT"/packages/db/prisma/migrations/*; do
    [[ -d "$migration" ]] || continue
    name="${migration##*/}"
    [[ "$applied" == *$'\n'"$name"$'\n'* ]] || { printf 'true'; return 0; }
  done
  printf 'false'
}

active_writer_release_commit() {
  if [[ -n "${TAXTRONIK_RELEASE_COMMIT:-}" ]]; then
    printf '%s' "$TAXTRONIK_RELEASE_COMMIT"
  else
    git -C "$ROOT" rev-parse HEAD 2>/dev/null || true
  fi
}

# Zentraler Start-Guard fuer alle Writer (app, worker, n8n). Infrastruktur
# bleibt separat ueber `compose --infra` startbar. Ein Produktionsrestore kann
# ausschliesslich durch den exakt passenden Rollback aktiviert werden. Ein
# offener Migrationsvertrag erlaubt nur den passenden internen Deploy-Start
# oder, falls garantiert keine Migration ausstand, den exakten Quell-Rollback.
assert_writer_start_authorized() {
  local reason="${_TAXTRONIK_INTERNAL_WRITER_START_REASON:-}"
  local target="${_TAXTRONIK_INTERNAL_WRITER_START_TARGET:-}"
  local restored_target restored_status pending_requirement pending_source pending_source_commit
  local pending_target pending_target_commit active_commit

  if [[ -f "$DB_RESTORE_AUTHORIZATION" && -f "$MIGRATION_PENDING" ]]; then
    die "Writer-Start blockiert: DB-Restore- und Migrations-Pending-Marker existieren gleichzeitig. Markerzustand vor jeder Aktivierung klaeren."
  fi

  if [[ -f "$DB_RESTORE_AUTHORIZATION" ]]; then
    restored_target="$(database_restore_authorized_target)"
    restored_status="$(database_restore_authorization_status)"
    [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
      die "Writer-Start blockiert: DB-Restore-Autorisierung ist ungueltig."
    [[ "$restored_status" == "ready" ]] || \
      die "Writer-Start blockiert: Produktions-DB-Restore ist nicht nachweislich erfolgreich abgeschlossen (Status: ${restored_status:-ungueltig})."
    [[ "$reason" == "rollback" && "$target" == "$restored_target" ]] || \
      die "Writer-Start blockiert: Die restaurierte Produktions-DB darf nur mit './taxtronik rollback $restored_target' aktiviert werden."
    return 0
  fi

  [[ -f "$MIGRATION_PENDING" ]] || return 0
  pending_requirement="$(pending_migration_value requires_db_restore)"
  pending_source="$(pending_migration_value source_version)"
  pending_source_commit="$(pending_migration_value source_commit)"
  pending_target="$(pending_migration_value target_version)"
  pending_target_commit="$(pending_migration_value target_commit)"
  [[ "$pending_requirement" == "true" || "$pending_requirement" == "false" || \
     "$pending_requirement" == "unknown" ]] || \
    die "Writer-Start blockiert: Migrations-Pending-Marker enthaelt keinen gueltigen Restore-Status."
  [[ -n "$pending_target" && "$pending_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Writer-Start blockiert: Migrations-Pending-Zielvertrag ist unvollstaendig oder ungueltig."
  active_commit="$(active_writer_release_commit)"

  if [[ "$reason" == "deploy" && "$target" == "$pending_target" && \
        "$active_commit" == "$pending_target_commit" ]]; then
    return 0
  fi
  if [[ "$reason" == "rollback" && "$pending_requirement" == "false" && \
        -n "$pending_source" && "$target" == "$pending_source" && \
        "$pending_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
        "$active_commit" == "$pending_source_commit" ]]; then
    return 0
  fi

  die "Writer-Start blockiert: Nicht finalisierter Migrationsvertrag (${pending_source:-Erstinstallation} -> $pending_target, Restore-Status: $pending_requirement). deploy/update bzw. den sicheren Restore-/Rollback-Pfad verwenden."
}

assert_no_database_restore_pending() {
  local restored_target
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  restored_target="$(database_restore_authorized_target)"
  [[ "$restored_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "DB-Restore-Autorisierung ist ungueltig; Deploy/Update bleibt blockiert."
  die "Produktions-DB wurde restauriert. Deploy/Update ist bis zur Aktivierung durch './taxtronik rollback $restored_target' blockiert."
}

merge_migration_restore_requirement() {
  local existing="$1" fresh="$2"
  [[ "$existing" == "true" || "$existing" == "false" || "$existing" == "unknown" ]] || \
    existing="unknown"
  [[ "$fresh" == "true" || "$fresh" == "false" || "$fresh" == "unknown" ]] || \
    fresh="unknown"
  if [[ "$existing" == "true" || "$fresh" == "true" ]]; then
    printf 'true'
  elif [[ "$existing" == "unknown" || "$fresh" == "unknown" ]]; then
    printf 'unknown'
  else
    printf 'false'
  fi
}

gwg_034_migration_is_fixed() {
  local migration="$ROOT/packages/db/prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql"
  local unsafe_count safe_count
  [[ -f "$migration" ]] || return 1
  unsafe_count="$(grep -Ec "'app\.destroy_gwg_(check|document_versions)\(uuid\)'::regprocedure" "$migration" || true)"
  safe_count="$(grep -Ec "pg_catalog\.to_regprocedure\('app\.destroy_gwg_(check|document_versions)\(uuid\)'\)" "$migration" || true)"
  [[ "$unsafe_count" == "0" && "$safe_count" == "7" ]]
}

database_has_recoverable_gwg_034_failure() {
  local result
  result="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT CASE WHEN
        EXISTS (
          SELECT 1
            FROM public._prisma_migrations
           WHERE migration_name = '20260801003400_gwg_fail_closed_and_destruction'
             AND finished_at IS NULL
             AND rolled_back_at IS NULL
             AND applied_steps_count = 0
             AND logs LIKE '%42883%'
             AND logs LIKE '%destroy_gwg_check(uuid)%'
        )
        AND pg_catalog.to_regprocedure('app.destroy_gwg_check(uuid)') IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE (table_schema, table_name, column_name) IN (
             ('public', 'gwg_check', 'legal_form'),
             ('public', 'gwg_check', 'register_number'),
             ('public', 'gwg_check', 'register_authority'),
             ('public', 'gwg_check', 'no_register_entry'),
             ('public', 'gwg_check', 'representative_names'),
             ('public', 'gwg_check', 'ownership_structure_notes'),
             ('public', 'document', 'gwg_onboarding_invite_id'),
             ('public', 'document', 'gwg_destruction_requested_at'),
             ('public', 'document', 'gwg_destruction_requested_by'),
             ('public', 'document', 'gwg_destruction_error'),
             ('public', 'document', 'gwg_destroyed_at')
           )
        )
        THEN 'yes' ELSE 'no'
      END" 2>/dev/null)" || return 1
  [[ "$result" == "yes" ]]
}

# GwG-Datenbankschutz: Single Source of Truth sind die versionierten SQL-Dateien
# unter packages/db/invariants/gwg. Jede Datei liefert genau eine Zeile je
# verletzter Invariante (stabiler Name); keine Zeile bedeutet "erfuellt". CI
# fuehrt dieselben Dateien mit packages/db/scripts/check-db-invariants.mjs gegen
# die echte, migrierte Datenbank aus (db- und upgrade-path-Job). Der Host
# braucht dafuer kein Node: Die Datei wird unveraendert per stdin an psql im
# Postgres-Container uebergeben und dort ausschliesslich read-only ausgefuehrt.
GWG_INVARIANTS_034="034-fail-closed-and-destruction.sql"
GWG_INVARIANTS_IDENTITY="043-identity-subjects-and-document-sets.sql"
GWG_INVARIANTS_044="044-legacy-guard-recovery.sql"

# run_gwg_invariant_check <datei unter packages/db/invariants/gwg>
#   0 = alle Invarianten erfuellt
#   1 = mindestens eine Invariante verletzt (Namen werden ausgegeben)
#   2 = SQL-, Verbindungs- oder Dateifehler; beweist nichts ueber den Schutz
#       und wird deshalb weder als erfuellt noch als "verletzt" gemeldet.
run_gwg_invariant_check() {
  local name="$1" file errors output violation status=0
  file="$ROOT/packages/db/invariants/gwg/$name"
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    warn "GwG-Invariantenpruefung $name nicht ausfuehrbar: Datei fehlt im Checkout ($file)."
    return 2
  fi
  errors="$(mktemp)" || {
    warn "GwG-Invariantenpruefung $name nicht ausfuehrbar: keine temporaere Fehlerdatei."
    return 2
  }
  # Der angehaengte Punkt bewahrt abschliessende Zeilenumbrueche: Auch eine
  # Verletzung mit leerem Namen bleibt eine Zeile und gilt nie als erfuellt.
  output="$(compose --infra exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on' postgres \
    psql -X -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -At -f - \
    <"$file" 2>"$errors" && printf '.')" || status=$?
  if (( status != 0 )); then
    warn "GwG-Invariantenpruefung $name: SQL-/Verbindungsfehler (Exit $status), keine Aussage ueber den Schutz:"
    sed 's/^/    /' "$errors" >&2 || true
    rm -f -- "$errors"
    return 2
  fi
  rm -f -- "$errors"
  output="${output%.}"
  [[ -n "$output" ]] || return 0
  warn "GwG-Invariante verletzt ($name):"
  while IFS= read -r violation; do
    printf '    %s\n' "${violation:-<Verletzung ohne Namen>}" >&2
  done <<<"${output%$'\n'}"
  return 1
}

database_has_gwg_034_invariants() { run_gwg_invariant_check "$GWG_INVARIANTS_034"; }
database_has_gwg_identity_invariants() { run_gwg_invariant_check "$GWG_INVARIANTS_IDENTITY"; }
database_has_gwg_044_invariants() { run_gwg_invariant_check "$GWG_INVARIANTS_044"; }

# 0 = erfuellt, 1 = verletzt, 2 = nicht pruefbar (SQL-/Verbindungsfehler). Die
# erste nicht erfuellte Pruefung bestimmt das Ergebnis.
database_has_gwg_invariants_for_checkout() {
  local migrations="$ROOT/packages/db/prisma/migrations"

  if [[ -d "$migrations/20260801003400_gwg_fail_closed_and_destruction" ||
        -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_034_invariants || return $?
  fi
  if [[ -d "$migrations/20260801004300_gwg_identity_subjects_and_document_sets" ||
        -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_identity_invariants || return $?
  fi
  if [[ -d "$migrations/20260801004400_legacy_gwg_guard_recovery" ]]; then
    database_has_gwg_044_invariants || return $?
  fi
}

database_is_fully_migrated_for_commit() {
  local commit="$1" open applied migrations migration name
  local requires_gwg_034=0 requires_gwg_identity=0 requires_gwg_044=0
  [[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1

  # Bei einem Legacy-Retry kann der neue Checkout bereits weitere Migrationen
  # enthalten. Entscheidend ist, dass die DB den im bestehenden Pending-Marker
  # gebundenen Ziel-Commit vollstaendig erreicht hat; erst danach duerfen dessen
  # Nachfolger im weiterhin restore-pflichtigen Vertrag angewendet werden.
  migrations="$(git -C "$ROOT" ls-tree -d --name-only \
    "$commit:packages/db/prisma/migrations" 2>/dev/null)" || return 1
  [[ -n "$migrations" ]] || return 1

  open="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT CASE WHEN EXISTS (
        SELECT 1
          FROM public._prisma_migrations
         WHERE finished_at IS NULL
           AND rolled_back_at IS NULL
       ) THEN 'yes' ELSE 'no' END" 2>/dev/null)" || return 1
  [[ "$open" == "no" ]] || return 1

  applied="$(compose --infra exec -T postgres \
    psql -U taxtronik -d taxtronik -v ON_ERROR_STOP=1 -Atc "
      SELECT migration_name
        FROM public._prisma_migrations
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL" 2>/dev/null)" || return 1
  applied=$'\n'"$applied"$'\n'
  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    name="${migration##*/}"
    [[ "$applied" == *$'\n'"$name"$'\n'* ]] || return 1
    if [[ "$name" == "20260801003400_gwg_fail_closed_and_destruction" ||
          "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_034=1
    fi
    if [[ "$name" == "20260801004300_gwg_identity_subjects_and_document_sets" ||
          "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_identity=1
    fi
    if [[ "$name" == "20260801004400_legacy_gwg_guard_recovery" ]]; then
      requires_gwg_044=1
    fi
  done <<< "$migrations"

  # `prisma migrate resolve --applied` schliesst nur das Journal und beweist
  # nicht, dass die DDL der fehlgeschlagenen Migration wirklich ausgefuehrt
  # wurde. Fuer Zielstaende ab 034 muessen deshalb auch deren DB-Schutzschichten
  # vollstaendig vorhanden sein; ab 043 gilt das zusaetzlich fuer die stabile
  # Subject-/Dokumentsatz-Zuordnung. Aeltere Releases behalten ihren damaligen
  # Vertrag und werden nicht nachtraeglich an spaetere Schemaobjekte gebunden.
  # Ein SQL-/Verbindungsfehler der Invariantenpruefung (2) wird weitergegeben
  # und vorher als solcher ausgegeben; er gilt nie als vollstaendig migriert.
  (( requires_gwg_034 == 0 )) || database_has_gwg_034_invariants || return $?
  (( requires_gwg_identity == 0 )) || database_has_gwg_identity_invariants || return $?
  (( requires_gwg_044 == 0 )) || database_has_gwg_044_invariants || return $?
}

can_retarget_verified_non_migration_transition() {
  local existing_source="$1" existing_source_commit="$2"
  local existing_target="$3" existing_target_commit="$4"
  local source_version="$5" source_commit="$6" target_version="$7" target_commit="$8"
  local existing_requirement="${9:-unknown}"

  # Dieser allgemeine Vorwaertspfad ist nur fuer einen nachweislich
  # migrationsfreien alten Vertrag zulaessig. Ein persistiertes `false` ist der
  # Primaerbeweis. War die damalige DB-Probe nur `unknown`, darf Git denselben
  # Beweis nachtraeglich liefern: Zwischen Quelle und altem Ziel existiert dann
  # exakt keine Aenderung am Prisma-Migrationsbaum. `true` bleibt dagegen an
  # seinem expliziten Recovery-Pfad gebunden.
  [[ "$existing_requirement" == "false" || "$existing_requirement" == "unknown" ]] || return 1
  [[ -n "$existing_source" && "$existing_source" == "$source_version" ]] || return 1
  [[ "$existing_source_commit" == "$source_commit" && \
     "$existing_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  [[ "$existing_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  [[ -n "$existing_target" && -n "$target_version" ]] || return 1
  if [[ "$existing_requirement" == "unknown" ]]; then
    git -C "$ROOT" diff --quiet "$existing_source_commit" "$existing_target_commit" -- \
      packages/db/prisma/migrations >/dev/null 2>&1 || return 1
  fi

  if [[ "$existing_target" =~ ^source-([0-9a-f]{12})$ && \
        "$target_version" =~ ^source-([0-9a-f]{12})$ ]]; then
    # Source-Versionen muessen nicht nur geordnet sein, sondern exakt auf die
    # beiden gebundenen Commits zeigen. So kann kein frei erfundener Alias den
    # Ancestry-Beweis passieren.
    [[ "$existing_target" == "source-${existing_target_commit:0:12}" && \
       "$target_version" == "source-${target_commit:0:12}" ]] || return 1
  else
    # Veroeffentlichte Releases sind unveraenderlich. Ein gleicher SemVer-Name
    # mit anderem Commit darf deshalb nie als Vorwaerts-Fortsetzung gelten.
    [[ "$existing_target" != "$target_version" && \
       "$existing_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
       "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    semver_ge "$target_version" "$existing_target" || return 1
  fi

  git -C "$ROOT" merge-base --is-ancestor "$existing_target_commit" "$target_commit" \
    >/dev/null 2>&1 || return 1
  # Den alten `false`-Marker nicht nur glauben: Journal, offene Migrationen und
  # die fuer diesen Ziel-Commit geltenden GwG-Invarianten werden erneut gegen
  # die echte Produktionsdatenbank belegt.
  database_is_fully_migrated_for_commit "$existing_target_commit"
}

can_retarget_recoverable_gwg_034_transition() {
  local existing_source="$1" existing_source_commit="$2"
  local existing_target="$3" existing_target_commit="$4"
  local source_version="$5" source_commit="$6" target_version="$7" target_commit="$8"
  local existing_requirement="${9:-unknown}" legacy_source=0

  [[ "$existing_source" == "$source_version" ]] || return 1
  if [[ -z "$existing_source_commit" && -z "$source_commit" ]]; then
    # Legacy-Lokalinstallationen vor Einfuehrung des Commit-Vertrags kennen den
    # Quell-Commit nicht. Sie duerfen nur vorwaerts fortgesetzt werden, wenn der
    # bestehende Marker jeden Ruecksprung bereits zwingend an einen DB-Restore
    # bindet; Ziel-Ancestry und DB-Zustand bleiben unten harte Beweise.
    [[ "$existing_requirement" == "true" ]] || return 1
    legacy_source=1
  else
    [[ "$existing_source_commit" == "$source_commit" && \
       "$existing_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  fi
  [[ "$existing_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  [[ -n "$existing_target" && -n "$target_version" ]] || return 1
  # Source-Kennungen wechseln absichtlich mit jedem Git-Commit; ihre Ordnung
  # beweist die Commit-Ancestry direkt darunter. Andere Tag-Wechsel muessen als
  # SemVer vergleichbar sein. Historische Nicht-SemVer-Tags bleiben nur bei
  # identischem Wert bestandskompatibel.
  if [[ "$existing_target" != "$target_version" ]]; then
    if [[ "$existing_target" =~ ^source-[0-9a-f]{12}$ && \
          "$target_version" =~ ^source-[0-9a-f]{12}$ ]]; then
      : # Commit-Ancestry ist unten das vollstaendige Ordnungs-Gate.
    else
      [[ "$existing_target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && \
         "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
      semver_ge "$target_version" "$existing_target" || return 1
    fi
  fi
  git -C "$ROOT" merge-base --is-ancestor "$existing_target_commit" "$target_commit" \
    >/dev/null 2>&1 || return 1
  gwg_034_migration_is_fixed || return 1
  database_has_recoverable_gwg_034_failure && return 0
  # Nach einer kontrollierten manuellen Prisma-Recovery kann der exakte 42883-
  # Zustand bereits beseitigt sein, waehrend der Legacy-Marker die Aktivierung
  # weiterhin schuetzt. Dann muss das Journal geschlossen und der alte
  # Marker-Zielcommit vollstaendig angewendet sein. Erst spaeter hinzugekommene
  # Zielmigrationen duerfen anschliessend unter derselben Restore-Pflicht laufen.
  (( legacy_source == 1 )) || return 1
  database_is_fully_migrated_for_commit "$existing_target_commit"
}

begin_migration_transition() {
  local tmp source_version source_commit target_version target_commit requirement
  local existing_source existing_source_commit existing_target existing_target_commit existing_requirement
  assert_no_database_restore_pending
  source_version="$(state_value current)"
  source_commit="$(state_value current_commit)"
  if [[ -z "$source_commit" && \
        "${_TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT:-}" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    # Legacy-State ohne current_commit: Nur der vor jedem Checkout-Wechsel
    # erfasste Start-Commit darf den neuen Vertrag vervollstaendigen. Bei einem
    # bereits vorhandenen Pending-Marker wird dieser Fallback nie gesetzt.
    source_commit="$_TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT"
  fi
  target_version="$(image_tag)"
  target_commit="${TAXTRONIK_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  requirement="$(pending_database_migration_requirement)"
  [[ "$requirement" == "true" || "$requirement" == "false" || "$requirement" == "unknown" ]] || \
    requirement="unknown"

  if [[ -f "$MIGRATION_PENDING" ]]; then
    existing_source="$(pending_migration_value source_version)"
    existing_source_commit="$(pending_migration_value source_commit)"
    existing_target="$(pending_migration_value target_version)"
    existing_target_commit="$(pending_migration_value target_commit)"
    existing_requirement="$(pending_migration_value requires_db_restore)"
    if [[ "$existing_source" != "$source_version" || \
          "$existing_source_commit" != "$source_commit" || \
          "$existing_target" != "$target_version" || \
          "$existing_target_commit" != "$target_commit" ]]; then
      if can_retarget_verified_non_migration_transition \
        "$existing_source" "$existing_source_commit" \
        "$existing_target" "$existing_target_commit" \
        "$source_version" "$source_commit" "$target_version" "$target_commit" \
        "$existing_requirement"; then
        warn "Verifizierten migrationsfreien Fehlerzustand erkannt; Pending-Vertrag wird auf den sicheren Vorwaerts-Commit fortgeschrieben."
      elif can_retarget_recoverable_gwg_034_transition \
        "$existing_source" "$existing_source_commit" \
        "$existing_target" "$existing_target_commit" \
        "$source_version" "$source_commit" "$target_version" "$target_commit" \
        "$existing_requirement"; then
        warn "Verifizierten GwG-Migrationsuebergang 03400 erkannt; Pending-Vertrag wird auf den sicheren Vorwaerts-Commit fortgeschrieben."
      else
        die "Migrations-Pending-Marker gehoert zu einem anderen Release-Uebergang (${existing_source:-Erstinstallation} -> ${existing_target:-unbekannt}, Restore-Status: ${existing_requirement:-ungueltig}) und wird nicht ueberschrieben. Erst bestehenden Fehlerzustand sicher aufloesen."
      fi
    fi
    requirement="$(merge_migration_restore_requirement "$existing_requirement" "$requirement")"
  fi

  tmp="$(mktemp "${MIGRATION_PENDING}.tmp.XXXXXX")" || \
    die "Migrations-Pending-Marker konnte nicht angelegt werden."
  {
    printf 'source_version=%s\n' "$source_version"
    printf 'source_commit=%s\n' "$source_commit"
    printf 'target_version=%s\n' "$target_version"
    printf 'target_commit=%s\n' "$target_commit"
    printf 'requires_db_restore=%s\n' "$requirement"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "Migrations-Pending-Marker konnte nicht gehaertet werden."; }
  mv -f "$tmp" "$MIGRATION_PENDING"
  chmod 0600 "$MIGRATION_PENDING" || die "Migrations-Pending-Marker konnte nicht gehaertet werden."
  info "Migrationsvertrag vorgemerkt (DB-Restore bei Ruecksprung: $requirement)."
}

clear_migration_transition() {
  [[ ! -e "$MIGRATION_PENDING" ]] || rm -f -- "$MIGRATION_PENDING"
}

write_database_restore_authorization() {
  local version="$1" status="$2" tmp
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
    die "Restore-Autorisierung braucht eine SemVer-Release-Version."
  [[ "$status" == "pending" || "$status" == "ready" ]] || \
    die "Restore-Autorisierung braucht einen gueltigen Status."
  tmp="$(mktemp "${DB_RESTORE_AUTHORIZATION}.tmp.XXXXXX")" || \
    die "DB-Restore-Autorisierung konnte nicht angelegt werden."
  {
    printf 'target_version=%s\n' "$version"
    printf 'status=%s\n' "$status"
    printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "DB-Restore-Autorisierung konnte nicht gehaertet werden."; }
  mv -f "$tmp" "$DB_RESTORE_AUTHORIZATION"
  chmod 0600 "$DB_RESTORE_AUTHORIZATION" || die "DB-Restore-Autorisierung konnte nicht gehaertet werden."
}

begin_database_restore_authorization() {
  local version="$1"
  # Vor der ersten moeglichen Restore-Seitenauswirkung persistieren. Bleibt der
  # Restore teilweise oder vollstaendig erfolglos, blockiert `pending` jeden
  # spaeteren Writer-Start bis zu einem erneut erfolgreichen Restore.
  write_database_restore_authorization "$version" pending
  # Die wiederhergestellte Datenbank liegt per Definition vor dem zuvor
  # vorgemerkten Migrationsversuch; dessen Marker darf nicht weiter blockieren.
  clear_migration_transition
}

authorize_database_restore_release() {
  local version="$1" existing_target existing_status
  existing_target="$(database_restore_authorized_target)"
  existing_status="$(database_restore_authorization_status)"
  [[ "$existing_target" == "$version" && "$existing_status" == "pending" ]] || \
    die "Restore-Autorisierung kann nicht finalisiert werden: passender Pending-Marker fehlt."
  write_database_restore_authorization "$version" ready
}

database_restore_authorized_target() {
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  grep -E '^target_version=' "$DB_RESTORE_AUTHORIZATION" | head -n1 | cut -d= -f2- || true
}

database_restore_authorization_status() {
  [[ -f "$DB_RESTORE_AUTHORIZATION" ]] || return 0
  grep -E '^status=' "$DB_RESTORE_AUTHORIZATION" | head -n1 | cut -d= -f2- || true
}

clear_database_restore_authorization() {
  [[ ! -e "$DB_RESTORE_AUTHORIZATION" ]] || rm -f -- "$DB_RESTORE_AUTHORIZATION"
}

# Schreibt den vollstaendigen Last-Good-Artefaktvertrag fuer Rollback.
# `previous` ist der zuvor erfolgreiche current-Stand; ein fehlgeschlagener
# Deploy erreicht diese Funktion nie und kann den Last-Good-Zeiger nicht
# ueberschreiben.
save_state() {
  local tmp new_version new_web new_worker new_commit new_restore_requirement
  local old_current old_web old_worker old_commit old_restore_requirement
  local previous previous_web previous_worker previous_commit
  new_version="$(image_tag)"
  new_web="${TAXTRONIK_WEB_DIGEST_SUFFIX:-}"
  new_worker="${TAXTRONIK_WORKER_DIGEST_SUFFIX:-}"
  new_commit="${TAXTRONIK_RELEASE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"
  old_current="$(state_value current)"
  old_web="$(state_value current_web_digest_suffix)"
  old_worker="$(state_value current_worker_digest_suffix)"
  old_commit="$(state_value current_commit)"
  old_restore_requirement="$(state_value current_rollback_requires_db_restore)"
  [[ "$old_restore_requirement" == "true" || "$old_restore_requirement" == "false" ]] || \
    old_restore_requirement="unknown"

  if [[ "$new_version" == "$old_current" && "$new_web" == "$old_web" && \
        "$new_worker" == "$old_worker" && "$new_commit" == "$old_commit" ]]; then
    # Ein idempotenter Redeploy darf den echten N-1-Rollbackzeiger nicht durch
    # current=current zerstoeren.
    previous="$(state_value previous)"
    previous_web="$(state_value previous_web_digest_suffix)"
    previous_worker="$(state_value previous_worker_digest_suffix)"
    previous_commit="$(state_value previous_commit)"
    # Der Stand selbst und sein echter N-1-Zeiger ändern sich nicht.
    new_restore_requirement="$old_restore_requirement"
  else
    previous="$old_current"
    previous_web="$old_web"
    previous_worker="$old_worker"
    previous_commit="$old_commit"
    new_restore_requirement="${TAXTRONIK_ROLLBACK_REQUIRES_DB_RESTORE:-$(pending_migration_value requires_db_restore)}"
    [[ "$new_restore_requirement" == "true" || "$new_restore_requirement" == "false" ]] || \
      new_restore_requirement="unknown"
  fi

  # Nach einem Produktions-DB-Restore ist nur die eben autorisierte ältere
  # Version mit dem restaurierten Schema bewiesen. Der automatisch entstehende
  # Rückweg zu `previous` (typischerweise neuerer Code) braucht mindestens
  # Migrationen und darf niemals als kompatibler Rollback markiert werden.
  # Der Restore-Marker bleibt bis nach save_state bestehen und macht diesen
  # Reverse-Pfad deshalb bewusst fail-closed.
  if [[ -e "$DB_RESTORE_AUTHORIZATION" ]]; then
    new_restore_requirement="unknown"
  fi

  tmp="$(mktemp "${STATE}.tmp.XXXXXX")" || die "Release-State konnte nicht angelegt werden."
  {
    printf 'previous=%s\n' "$previous"
    printf 'previous_web_digest_suffix=%s\n' "$previous_web"
    printf 'previous_worker_digest_suffix=%s\n' "$previous_worker"
    printf 'previous_commit=%s\n' "$previous_commit"
    printf 'current=%s\n' "$new_version"
    printf 'current_web_digest_suffix=%s\n' "$new_web"
    printf 'current_worker_digest_suffix=%s\n' "$new_worker"
    printf 'current_commit=%s\n' "$new_commit"
    printf 'current_rollback_requires_db_restore=%s\n' "$new_restore_requirement"
  } > "$tmp"
  chmod 0600 "$tmp" || { rm -f "$tmp"; die "Release-State konnte nicht auf 0600 gehaertet werden."; }
  mv -f "$tmp" "$STATE"
  chmod 0600 "$STATE" || die "Release-State konnte nicht auf 0600 gehaertet werden."
}

finalize_release_contract() {
  # Beide Aufrufe liegen bewusst erst hinter Health + Readiness. STATE ist der
  # massgebliche Last-Good-Zeiger und wird atomar vor den .env-Eintraegen
  # aktualisiert; jeder Zwischenzustand wird vom Compose-Guard abgewiesen.
  save_state
  commit_release_contract
  clear_migration_transition
  clear_database_restore_authorization
  rm -f -- "$INSTALL_PENDING"
}
