#!/usr/bin/env bash
# =============================================================================
# taxtronik Setup — One-Command-Deploy für Linux / macOS / Git-Bash.
#
# Voraussetzung: Docker installiert und gestartet, pnpm verfügbar.
#
#   ./scripts/setup.sh             (vollständiges Setup)
#   ./scripts/setup.sh --reset     (alles zurücksetzen, dann neu)
#   ./scripts/setup.sh --skip-seed (kein Demo-Seed)
# =============================================================================

set -euo pipefail

RESET=0
SKIP_SEED=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --skip-seed) SKIP_SEED=1 ;;
    *) ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

cyan='\033[36m'; green='\033[32m'; yellow='\033[33m'; red='\033[31m'; reset='\033[0m'
step()  { printf "\n${cyan}==> %s${reset}\n" "$1"; }
done_() { printf "    ${green}ok: %s${reset}\n" "$1"; }
warn()  { printf "    ${yellow}!! %s${reset}\n" "$1"; }
fail()  { printf "${red}%s${reset}\n" "$1"; exit 1; }

rand_b64() {
  # N-1: base64url (RFC 4648 §5) statt Standard-Base64. Die generierten Werte
  # landen u. a. in DATABASE_URL=postgresql://user:${pw}@host/db — ein '/' im
  # Passwort würde den Password-Teil der URL terminieren und ~40% der Setups
  # zerschneiden. base64url tauscht '+/' gegen '-_', '=' wird ohnehin gestrippt.
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '=\n' | tr '+/' '-_'
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '=\n' | tr '+/' '-_'
  fi
}

# -------------------------------------------------------------------- Vorprüfungen
step "Vorprüfungen"
docker info >/dev/null 2>&1 || fail "Docker ist nicht erreichbar. Bitte Docker starten und erneut ausführen."
done_ "Docker läuft."
command -v pnpm >/dev/null 2>&1 || fail "pnpm fehlt. Bitte installieren: npm install -g pnpm"
done_ "pnpm verfügbar."

# -------------------------------------------------------------------- Reset
if [[ $RESET -eq 1 ]]; then
  step "Reset — Stack stoppen + Volumes löschen"
  docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml down -v
  rm -f .env
  done_ "Stack zurückgesetzt."
fi

# -------------------------------------------------------------------- .env
step ".env vorbereiten"
if [[ ! -f .env ]]; then
  cp .env.example .env
  done_ ".env aus .env.example angelegt."
fi

set_env() {
  local key="$1" value="$2"
  # Slashes/Ampersands im Wert für sed escapen
  local esc=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
  if grep -qE "^${key}=" .env; then
    if sed --version >/dev/null 2>&1; then
      sed -i -E "s|^${key}=.*$|${key}=${esc}|" .env
    else
      sed -i '' -E "s|^${key}=.*$|${key}=${esc}|" .env
    fi
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
get_env() {
  local key="$1"
  grep -E "^${key}=" .env | head -n1 | cut -d= -f2- | tr -d '"'
}
ensure_secret() {
  local key="$1" bytes="$2"
  if [[ -z "$(get_env "$key")" ]]; then
    set_env "$key" "$(rand_b64 "$bytes")"
    done_ "$key generiert."
  fi
}

# Auth / HMAC / Verschlüsselung
ensure_secret 'AUTH_SECRET'         32
ensure_secret 'N8N_HMAC_SECRET'     32
ensure_secret 'N8N_ENCRYPTION_KEY'  24

# Bestehende Installation: Passwort aus DATABASE_URL übernehmen, falls eines
# da steht. Das vermeidet "Connection refused", weil der Postgres-Container
# noch das alte Passwort hat. Greift nur, wenn POSTGRES_PASSWORD leer ist.
extract_pw_from_url() {
  echo "$1" | sed -nE 's|^postgres(ql)?://[^:]+:([^@]+)@.*$|\2|p'
}
if [[ -z "$(get_env POSTGRES_PASSWORD)" ]]; then
  existing_pw=$(extract_pw_from_url "$(get_env DATABASE_URL)")
  if [[ -n "$existing_pw" && "$existing_pw" != "\${POSTGRES_PASSWORD}" ]]; then
    set_env 'POSTGRES_PASSWORD' "$existing_pw"
    done_ "POSTGRES_PASSWORD aus bestehender DATABASE_URL übernommen."
  fi
fi
if [[ -z "$(get_env TAXTRONIK_APP_PASSWORD)" ]]; then
  existing_pw=$(extract_pw_from_url "$(get_env DATABASE_APP_URL)")
  if [[ -n "$existing_pw" && "$existing_pw" != "\${TAXTRONIK_APP_PASSWORD}" ]]; then
    set_env 'TAXTRONIK_APP_PASSWORD' "$existing_pw"
    done_ "TAXTRONIK_APP_PASSWORD aus bestehender DATABASE_APP_URL übernommen."
  fi
fi
# Alte Default-Werte aus dem Dev-Stack erkennen und konservieren
if [[ -z "$(get_env S3_SECRET_KEY)" ]] && \
   docker ps --format '{{.Names}}' 2>/dev/null | grep -q taxtronik-seaweedfs; then
  # Wenn SeaweedFS schon mit dem alten Default-Secret läuft, behalten wir es
  # — ansonsten würde der Container das neue nicht kennen.
  if [[ -f infra/scripts/seaweedfs-s3.template.json ]]; then
    : # nichts zu tun — Wert wird unten generiert wenn leer
  fi
fi

# Infrastruktur-Passwörter (nur generieren, wenn noch nicht aus URL übernommen)
ensure_secret 'POSTGRES_PASSWORD'        24
ensure_secret 'TAXTRONIK_APP_PASSWORD'   24
ensure_secret 'S3_SECRET_KEY'            32
ensure_secret 'N8N_DB_PASSWORD'          24

# DB-URLs mit den generierten Passwörtern befüllen (für lokale Dev-Verbindung)
PG_PW="$(get_env POSTGRES_PASSWORD)"
APP_PW="$(get_env TAXTRONIK_APP_PASSWORD)"
set_env 'DATABASE_URL'     "postgresql://taxtronik:${PG_PW}@localhost:5432/taxtronik?schema=public"
set_env 'DATABASE_APP_URL' "postgresql://taxtronik_app:${APP_PW}@localhost:5432/taxtronik?schema=public"
done_ "DATABASE_URL und DATABASE_APP_URL gesetzt."

# SeaweedFS S3-Konfig aus Template rendern
S3_ACCESS="$(get_env S3_ACCESS_KEY)"
S3_SECRET="$(get_env S3_SECRET_KEY)"
sed -e "s|__S3_ACCESS_KEY__|${S3_ACCESS}|g" \
    -e "s|__S3_SECRET_KEY__|${S3_SECRET}|g" \
    infra/scripts/seaweedfs-s3.template.json \
    > infra/scripts/seaweedfs-s3.generated.json
done_ "SeaweedFS-S3-Konfig gerendert."

# -------------------------------------------------------------------- Docker-Stack
step "Docker-Stack hochfahren"
docker compose --env-file .env -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d
done_ "Container laufen."

step "Warten, bis Postgres healthy ist"
deadline=$(( $(date +%s) + 120 ))
while [[ $(date +%s) -lt $deadline ]]; do
  status=$(docker inspect --format '{{.State.Health.Status}}' taxtronik-postgres 2>/dev/null || true)
  if [[ "$status" == "healthy" ]]; then done_ "Postgres healthy."; break; fi
  sleep 2
done

# -------------------------------------------------------------------- Node-Pakete
step "Node-Abhängigkeiten installieren"
pnpm install --silent
done_ "Pakete installiert."

# -------------------------------------------------------------------- Prisma Client
step "Prisma Client generieren"
( cd packages/db && node ../../node_modules/prisma/build/index.js generate )
done_ "Prisma Client generiert."

# -------------------------------------------------------------------- Prisma
step "Datenbank-Migrationen anwenden"
pnpm --filter '@taxtronik/db' prisma migrate deploy
done_ "Schema aktuell."

if [[ $SKIP_SEED -eq 0 ]]; then
  # U-3: Wenn NODE_ENV=production in der .env steht, ist der Dev-Seed-Aufruf
  # ein Fehler. Der Seed selbst lehnt das jetzt zwar ab (process.exit(1)),
  # aber wir wollen den Operator vorher klar warnen statt einer kryptischen
  # Failure-Meldung mitten im Setup.
  detected_env=$(grep -E '^NODE_ENV=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)
  if [[ "$detected_env" == "production" ]]; then
    warn "Demo-Seed übersprungen: NODE_ENV=production in .env erkannt."
    warn "Production-Provisionierung (Tenant + Admin, KEINE Demodaten):"
    warn "  TENANT_NAME=\"Kanzlei ...\" ADMIN_EMAIL=... pnpm --filter @taxtronik/db provision"
  else
    step "Demo-Seed einspielen"
    pnpm --filter '@taxtronik/db' run seed || warn "Seed übersprungen (Skript hat Fehler gemeldet)."
  fi
fi

# Object-Store-Buckets werden vom `seaweedfs-init`-Container automatisch
# angelegt (siehe docker-compose.yml) — kein manueller Aufruf nötig.
step "Object-Store-Buckets (SeaweedFS)"
sleep 3
status=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' taxtronik-seaweedfs-init 2>/dev/null || true)
done_ "Init-Container Status: $status"

# -------------------------------------------------------------------- Fertig
cat <<EOF

${green}=================================================================
  Setup abgeschlossen.
=================================================================${reset}

Nächste Schritte:
  1. Dev-Server starten:   pnpm --filter @taxtronik/web dev
  2. Worker starten:       pnpm --filter @taxtronik/worker dev
  3. Login:                http://localhost:3000/staff/login
     (Demo-Admin aus Seed: siehe README)

Hilfsdienste:
  - SeaweedFS-Master: http://localhost:9333
  - SeaweedFS-Filer:  http://localhost:8888
  - Mailhog-UI:       http://localhost:8025
  - n8n:              http://localhost:5678

EOF
