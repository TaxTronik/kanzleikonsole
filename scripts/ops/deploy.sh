#!/usr/bin/env bash
# =============================================================================
# Aktivierung und ./taxtronik deploy — Teil der Operator-CLI (./taxtronik).
#
# Infra-/App-Start, Health-Smoke, Deploy-Readiness, Host-Werkzeuge
# (Prisma/tsx) und die Kommandos deploy, config und bootstrap.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

start_infra() { info "Infra starten"; compose --infra up -d; }
start_apps()  {
  assert_writer_start_authorized
  local services=(app worker n8n)
  if [[ "$(deployment_method)" == "traefik" ]]; then
    services+=(traefik)
    info "App, Worker, n8n und verwaltetes Traefik starten/neu erzeugen"
  else
    info "App, Worker und n8n starten/neu erzeugen"
  fi
  run_backup_dir_init
  compose up -d --force-recreate --no-deps "${services[@]}"
}

# Bash-`local` ist dynamisch sichtbar: start_apps und der darin aufgerufene
# Compose-Wrapper sehen diese Werte, ohne dass eine vom Operator setzbare
# Umgebungsvariable exportiert werden muss.
start_apps_for_activation() {
  local _TAXTRONIK_INTERNAL_WRITER_START_REASON="${1:-}"
  local _TAXTRONIK_INTERNAL_WRITER_START_TARGET="${2:-}"
  [[ -n "$_TAXTRONIK_INTERNAL_WRITER_START_REASON" && \
     -n "$_TAXTRONIK_INTERNAL_WRITER_START_TARGET" ]] || \
    die "Interne Writer-Aktivierung braucht Grund und Zielversion."
  start_apps
}

smoke_health() {
  local url status
  url="http://127.0.0.1:$(app_port)/api/health"
  info "Health-Smoke: $url"
  for _ in {1..30}; do
    # KEIN curl -f: wir lesen den JSON-Status selbst. `degraded` bedeutet, dass
    # mindestens eine produktive Abhaengigkeit ausgefallen ist, und darf einen
    # Deploy/Update deshalb NICHT als erfolgreich markieren.
    status="$(curl -sS "$url" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(s).status||'')}catch{process.exit(1)}})" 2>/dev/null || true)"
    if [[ "$status" == "ok" ]]; then echo "Health: ok"; return 0; fi
    sleep 2
  done
  compose ps
  compose logs app --tail 80 || true
  warn "Health-Smoke fehlgeschlagen (nur status=ok gilt als bereit)."
  return 1
}

# Prod-Konfigurations-Gate NACH dem Deploy. smoke_health prueft nur die
# ERREICHBARKEIT (der /api/health-Endpoint aus dem Container); dieser Check geht
# tiefer und faengt prod-spezifische KONFIGURATIONS-Fehler (S3-Buckets fehlen /
# kein Object-Lock, ClamAV-StreamMaxLength < Upload-Cap, keine ClamAV-Signaturen,
# Storage-Schreib/Lese-Roundtrip kaputt) — genau die Klasse, die sonst erst beim
# Kunden auffaellt (z. B. der GwG-Upload). Laeuft als Host-Tool gegen die
# VEROEFFENTLICHTEN Ports (docker port), unabhaengig von den internen
# Container-Endpunkten. Mit Retry: frisches ClamAV laedt die Signaturen (EICAR)
# ggf. erst nach dem TCP-Up per freshclam.
deploy_readiness() {
  local s3_hp clam_hp s3_endpoint clam_host clam_port gwg_status=0
  database_has_gwg_invariants_for_checkout || gwg_status=$?
  if (( gwg_status == 2 )); then
    warn "Deploy-Readiness fehlgeschlagen: GwG-Datenbankschutz konnte wegen eines SQL-/Verbindungsfehlers nicht geprueft werden (siehe oben)."
    return 1
  elif (( gwg_status != 0 )); then
    warn "Deploy-Readiness fehlgeschlagen: GwG-Datenbankschutz entspricht nicht dem Migrationsstand dieses Checkouts."
    return 1
  fi
  s3_hp="$(docker port taxtronik-seaweedfs 8333 2>/dev/null | head -n1 || true)"
  clam_hp="$(docker port taxtronik-clamav 3310 2>/dev/null | head -n1 || true)"
  if [[ -z "$s3_hp" || -z "$clam_hp" ]]; then
    warn "Deploy-Readiness fehlgeschlagen: SeaweedFS/ClamAV-Hostports nicht ermittelbar."
    return 1
  fi
  s3_endpoint="http://${s3_hp/0.0.0.0/127.0.0.1}"
  clam_host="${clam_hp%%:*}"; clam_host="${clam_host/0.0.0.0/127.0.0.1}"
  clam_port="${clam_hp##*:}"

  # Nach einem Update/Rollback koennen die Host-node_modules noch zum alten
  # Checkout gehoeren. Vor dem Retry-Loop synchronisieren, damit ein pnpm-
  # Workspace-Fehler nicht viermal faelschlich als ClamAV-Wartezeit erscheint.
  ensure_host_tool_deps

  info "Deploy-Readiness: S3=$s3_endpoint ClamAV=$clam_host:$clam_port"
  local attempt
  for attempt in 1 2 3 4; do
    if ( cd "$ROOT" && \
         S3_ENDPOINT="$s3_endpoint" CLAMAV_HOST="$clam_host" CLAMAV_PORT="$clam_port" \
         pnpm --filter @taxtronik/storage verify:deploy ); then
      info "Deploy-Readiness OK."
      return 0
    fi
    if [[ $attempt -lt 4 ]]; then
      warn "Deploy-Readiness noch nicht bereit (Versuch $attempt/4) — 20 s warten (ClamAV-Signaturen?)."
      sleep 20
    fi
  done
  warn "Deploy-Readiness fehlgeschlagen — Prod-Konfiguration nicht bereit (S3-Buckets/Object-Lock/ClamAV/Roundtrip)."
  return 1
}

resolve_prisma_cli() {
  local candidate
  for candidate in \
    "$ROOT/node_modules/prisma/build/index.js" \
    "$ROOT/packages/db/node_modules/prisma/build/index.js"
  do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  candidate="$(find "$ROOT/node_modules" "$ROOT/packages/db/node_modules" \
    -path '*/prisma/build/index.js' -not -path '*/cache/*' 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" && -f "$candidate" ]] && printf '%s\n' "$candidate"
  return 0
}

resolve_tsx_cli() {
  local candidate
  for candidate in \
    "$ROOT/node_modules/tsx/dist/cli.mjs" \
    "$ROOT/apps/web/node_modules/tsx/dist/cli.mjs" \
    "$ROOT/packages/db/node_modules/tsx/dist/cli.mjs"
  do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  candidate="$(find "$ROOT/node_modules" "$ROOT/apps/web/node_modules" "$ROOT/packages/db/node_modules" \
    -path '*/tsx/dist/cli.mjs' -not -path '*/cache/*' 2>/dev/null | head -n1 || true)"
  [[ -n "$candidate" && -f "$candidate" ]] && printf '%s\n' "$candidate"
  return 0
}

host_tool_deps_ready() {
  [[ -n "$(resolve_prisma_cli)" && -n "$(resolve_tsx_cli)" ]]
}

host_tool_deps_current() {
  host_tool_deps_ready || return 1
  # `verifyDepsBeforeRun: error` schuetzt vor veralteten injected Workspace-
  # Snapshots. Ein Checkout-Wechsel kann package.json-Dateien aendern, obwohl
  # Prisma/tsx noch vorhanden sind; die reine Existenzpruefung reicht dann
  # nicht. Der harmlose pnpm-Probe-Run nutzt exakt denselben Guard wie die
  # anschliessenden Host-Kommandos, erzeugt aber keine Seiteneffekte.
  ( cd "$ROOT" && pnpm --filter @taxtronik/storage exec node -e 'process.exit(0)' ) \
    >/dev/null 2>&1
}

ensure_host_tool_deps() {
  host_tool_deps_current && return 0
  require_cmd pnpm
  info "Host-Tool-Abhaengigkeiten mit aktuellem Checkout synchronisieren (Prisma/tsx/Readiness)"
  # NODE_ENV=production laesst pnpm devDependencies sonst aus. Die Host-Tools
  # laufen zwar auf einem Prod-Server, brauchen aber Prisma CLI + tsx aus den
  # workspace-devDependencies. Der Install-Lauf aktualisiert zugleich pnpm's
  # injected Workspace-Snapshots nach einem git-Checkout-Wechsel. Runtime
  # bleibt trotzdem containerisiert.
  (cd "$ROOT" && pnpm install --frozen-lockfile --prod=false \
    --filter @taxtronik/web... --filter @taxtronik/web --filter @taxtronik/db)
  host_tool_deps_current || \
    die "Host-Tool-Abhaengigkeiten sind nach pnpm install nicht mit dem Checkout synchron. Bitte pnpm-Install-Log pruefen."
}

generate_prisma_client_for_host_tools() {
  require_cmd node
  ensure_host_tool_deps
  local prisma_cli
  prisma_cli="$(resolve_prisma_cli)"
  [[ -n "$prisma_cli" ]] || die "Prisma CLI fehlt nach Host-Tool-Install."
  info "Prisma Client generieren (Host-Tools)"
  (cd "$ROOT/packages/db" && node "$prisma_cli" generate)
}

# Gemeinsame Deploy-Sequenz. Enthaelt die Erstinstall-Erkennung, sodass deploy
# eine frische Installation komplett abdeckt.
_deploy_core() {
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
  assert_no_database_restore_pending
  ensure_host_tool_deps
  prepare_release_contract
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  provide_traefik_for_deploy
  provide_signal_for_deploy deploy
  backup_before_migrations
  run_migrations
  ensure_provisioned_interactive
  ensure_managed_n8n_connection
  start_signal_for_deploy || die "Deploy abgebrochen: verwaltetes Signal ist nicht bereit."
  start_apps_for_activation deploy "$(image_tag)"
  smoke_health || die "Deploy abgebrochen: Anwendung ist nicht vollstaendig healthy."
  smoke_public_frontend || die "Deploy abgebrochen: verwaltetes Traefik/TLS ist nicht oeffentlich bereit."
  deploy_readiness || die "Deploy abgebrochen: Produktivkonfiguration ist nicht bereit."
  finalize_release_contract
}

# ---------------------------------------------------------------------------
# Operator-Kommandos (aufgerufen vom Dispatcher ./taxtronik)
# ---------------------------------------------------------------------------
cmd_config() {
  if [[ -f "$ENVFILE" ]]; then
    info "Konfiguration ist bereits vorhanden: $ENVFILE"
    info "Validierung/Auffuellen: ./taxtronik doctor --fix"
    return 0
  fi
  [[ -t 0 ]] || die "Initialkonfiguration braucht ein interaktives Terminal."
  configure_initial_deployment_interactive
  info "Konfiguration gespeichert. Mit './taxtronik deploy' wird sie angewendet."
}

cmd_deploy() {
  configure_initial_deployment_interactive
  ensure_bootstrap_host_requirements
  prepare_env_interactive
  _deploy_core
  info "Deploy fertig. Version: $(image_tag)"
  cat <<EOF

=================================================================
  Deployment abgeschlossen. Version: $(image_tag)
=================================================================
  Staff-Login : (NEXTAUTH_URL aus .env)/staff/login
  n8n-Setup   : https://${N8N_HOST:-nicht-konfiguriert}/ (Owner anlegen, API-Key erzeugen)
                Danach den Key im ACP unter Einstellungen -> n8n eintragen.
  Admin-Zugang: siehe $ROOT/.admin-credentials.txt (falls neu angelegt)
                Nach erstem Login + TOTP-Setup die Datei sicher loeschen.

  Naechste Schritte:
    ./taxtronik doctor     # Konfiguration pruefen
    ./taxtronik logs app   # Logs ansehen
    ./taxtronik update     # Updates einspielen
EOF
}

# Historischer Alias. Neue Installationen und bestehende Systeme verwenden
# denselben vollstaendigen Hauptweg `deploy`.
cmd_bootstrap() {
  warn "'./taxtronik bootstrap' ist nur noch ein Kompatibilitaetsalias. Bitte kuenftig './taxtronik deploy' verwenden."
  cmd_deploy "$@"
}
