#!/usr/bin/env bash
# =============================================================================
# Shared helpers für die taxtronik Operator-CLI (./taxtronik).
#
# Wird von ./taxtronik gesourcet. Diese Datei setzt Shell-Optionen, umask,
# Pfade und alle Pins/Defaults und lädt danach die Domänendateien unter
# scripts/ops/ in fester Reihenfolge (Source-Block am Dateiende):
#   - core, env, compose: Ausgabe/Preflight, .env, docker-compose-Wrapper (ehemals ./dc)
#   - traefik, signal, release, postgres: Oberfläche, Signal, Release-Vertrag, DB-Rollen
#   - doctor: vorab .env-Validierung statt telemetrischem Mid-Deploy-Abbruch
#   - provision, deploy: Erstkonfiguration + Build + Migration + Start + Smoke;
#     bootstrap bleibt veralteter Kompatibilitätsalias für deploy
#   - backup, restore, migration, update, rollback: weitere Operator-Abläufe
#
# Dev/Prod-Trennung: auf dem Server läuft NUR Prod. .env auf dem Server ist
# immer eine Prod-.env (erzeugt via ./taxtronik deploy). Das Dev-setup
# (scripts/setup.sh) ist ausschließlich für Entwickler-Maschinen und erzeugt
# bewusst eine DEV-.env — genau das war früher die Quelle der "deploy meckert"-
# Kollision, weil beide in dieselbe .env schrieben.
# =============================================================================
set -euo pipefail

# Operator-Konfigurationen enthalten produktive Zugangsdaten. Neue Dateien
# duerfen deshalb auch waehrend ihrer Erzeugung nie ueber Gruppen-/World-Rechte
# verfuegen; explizitere chmod-Aufrufe unten haerten auch bereits vorhandene
# Installationen nach.
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVFILE="$ROOT/.env"
BASE="$ROOT/infra/compose/docker-compose.yml"
APP="$ROOT/infra/compose/docker-compose.app.yml"
# shellcheck disable=SC2034 # seit dem Baseline-Snapshot ungenutzt; Entfernen ist eine eigene Aufraeumentscheidung
DEV="$ROOT/infra/compose/docker-compose.dev.yml"
TRAEFIK="$ROOT/infra/compose/docker-compose.traefik.yml"
TRAEFIK_DYNAMIC="$ROOT/.taxtronik.traefik-dynamic.yml"
S3_GENERATED="$ROOT/infra/scripts/seaweedfs-s3.generated.json"
STATE="$ROOT/.taxtronik.state"
MIGRATION_PENDING="$ROOT/.taxtronik.migration-pending"
DB_RESTORE_AUTHORIZATION="$ROOT/.taxtronik.database-restored"
INSTALL_PENDING="$ROOT/.taxtronik.install-pending"
UPDATE_HANDOFF="$ROOT/.taxtronik.update-handoff"
AWS_CLI_IMAGE_DEFAULT="amazon/aws-cli:latest@sha256:c95ab0642137f55a12b95b6956dd03cefdbd73e760e0e7b870afc9b47f9c8150"
ALPINE_BACKUP_IMAGE_DEFAULT="alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
# Der Wert wird zusammen mit einem TaxTronik-Release getestet und angehoben.
# `SIGNAL_IMAGE=auto` folgt genau diesem Pin; ein externer/nativer Dienst wird
# dagegen niemals ueber diesen Pfad angefasst.
SIGNAL_MANAGED_IMAGE_DEFAULT="git.hirschmann-koxha.de/taxtronik/risk-layer-engine:v0.1.0"
SIGNAL_GIT_URL_DEFAULT="https://git.hirschmann-koxha.de/TaxTronik/signal.git"
# Bewusst leer: Ein Signal-Source-Build fuehrt Skripte aus dem Signal-Checkout
# auf dem Host aus. Ohne ausdrueckliche Wahl wird daher kein beweglicher Branch
# (frueher `main`) gebaut. Im Repository ist kein getesteter Signal-Commit
# gepinnt; Betreiber setzen SIGNAL_GIT_REF auf einen vollstaendigen Commit-SHA
# (empfohlen) oder ein explizites refs/tags/<Tag>.
SIGNAL_GIT_REF_DEFAULT=""
# Vertrauensanker fuer Source-Kanal-Updates ausserhalb von Produktion (S-04;
# Produktion nur ueber den Release-Kanal). Liegt ausserhalb jedes Checkouts;
# Signer-Konfiguration aus dem geholten Baum oder der Repo-Config wird nie
# verwendet. TAXTRONIK_SOURCE_ALLOWED_SIGNERS ueberschreibt den Pfad.
TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT="/etc/taxtronik/allowed_signers"
SIGNAL_MANAGED_LLM_MODEL="granite-4.1-8b"
SIGNAL_MANAGED_LLM_FILE="granite-4.1-8b-Q5_K_M.gguf"
SIGNAL_MANAGED_LLM_SIZE_BYTES=6253884064
SIGNAL_MANAGED_LLM_TIMEOUT_DEFAULT=900
TAXTRONIK_RELEASE_IMAGE_PREFIX_DEFAULT="git.hirschmann-koxha.de/taxtronik"
TAXTRONIK_UPDATE_MANIFEST_URL_DEFAULT="https://git.hirschmann-koxha.de/TaxTronik/updates/raw/branch/main/manifest.json"
TAXTRONIK_UPDATE_PUBLIC_KEY_DEFAULT="NE1YtBNNPFM545o1VqoBNTcKIPmZP0rmvLq22YyqKaU="
HOST_NODE_VERSION="24.19.0"
HOST_NODE_LINUX_X64_SHA256="14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"
HOST_NODE_LINUX_ARM64_SHA256="01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc"
HOST_PNPM_VERSION="12.4.1"

# Interne Autorisierungen gelten nur im dynamischen Scope der unten definierten
# Aktivierungs-Wrapper. Geerbte Shell-Variablen duerfen einen Operator-Aufruf
# niemals autorisieren (auch nicht den bestehenden Release-Contract-Guard).
while IFS= read -r _taxtronik_internal_name; do
  unset "$_taxtronik_internal_name"
done < <(compgen -A variable _TAXTRONIK_INTERNAL_ || true)
unset _taxtronik_internal_name

# ---------------------------------------------------------------------------
# Domänendateien. Sie definieren nur Funktionen und domänenlokale Konstanten;
# Seitenwirkungen beim Laden gibt es ausschließlich oben in dieser Datei. Die
# Reihenfolge ist fest, für das Verhalten aber ohne Bedeutung: Funktionen
# werden erst aufgerufen, nachdem alle Dateien geladen sind. Fehlt eine Datei,
# bricht das Laden wegen `set -e` ab.
# ---------------------------------------------------------------------------
# shellcheck source=ops/core.sh
source "$ROOT/scripts/ops/core.sh"
# shellcheck source=ops/env.sh
source "$ROOT/scripts/ops/env.sh"
# shellcheck source=ops/compose.sh
source "$ROOT/scripts/ops/compose.sh"
# shellcheck source=ops/traefik.sh
source "$ROOT/scripts/ops/traefik.sh"
# shellcheck source=ops/signal.sh
source "$ROOT/scripts/ops/signal.sh"
# shellcheck source=ops/release.sh
source "$ROOT/scripts/ops/release.sh"
# shellcheck source=ops/postgres.sh
source "$ROOT/scripts/ops/postgres.sh"
# shellcheck source=ops/doctor.sh
source "$ROOT/scripts/ops/doctor.sh"
# shellcheck source=ops/provision.sh
source "$ROOT/scripts/ops/provision.sh"
# shellcheck source=ops/backup.sh
source "$ROOT/scripts/ops/backup.sh"
# shellcheck source=ops/restore.sh
source "$ROOT/scripts/ops/restore.sh"
# shellcheck source=ops/migration.sh
source "$ROOT/scripts/ops/migration.sh"
# shellcheck source=ops/deploy.sh
source "$ROOT/scripts/ops/deploy.sh"
# shellcheck source=ops/update.sh
source "$ROOT/scripts/ops/update.sh"
# shellcheck source=ops/rollback.sh
source "$ROOT/scripts/ops/rollback.sh"
