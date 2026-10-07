#!/usr/bin/env bash
# =============================================================================
# ./taxtronik update — Teil der Operator-CLI (./taxtronik).
#
# Produktionsgate des Source-Kanals und dessen Signaturbindung (S-04),
# Update-Handoff zwischen altem und neuem Operator und der Update-Ablauf.
#
# Wird ausschliesslich von scripts/ops-lib.sh gesourcet und nutzt deren
# Shell-Optionen, Pfade und Pins. Definiert nur Funktionen und
# domaenenlokale Konstanten; beim Laden hat die Datei keine Seitenwirkung.
# =============================================================================

# ---------------------------------------------------------------------------
# Source-Kanal: Produktionsgate und Signaturbindung (S-04)
#
# Produktion wird ausschliesslich ueber den Release-Kanal aktualisiert
# (Betreiberentscheidung "C"): Er bindet Updates an das Ed25519-signierte
# Manifest und an CI-gepruefte Registry-Images. deploy und update verweigern
# den Source-Kanal in Produktion vor jedem Backup, Fetch, Build und jeder
# Migration; SSH-Signaturen schalten dort nichts mehr frei.
#
# Ausserhalb von Produktion bleibt die Signaturbindung: Vor dem Fast-forward
# und damit vor dem ersten Start des aktualisierten Operators muss der exakte
# Ziel-Commit oder ein annotierter Tag mit genau diesem Commit als Ziel von
# einem Signer aus einer gepinnten allowed_signers-Datei ausserhalb des
# Checkouts signiert sein. Ohne Signer gibt es dort nur eine Warnung. Das
# fruehere Opt-out TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE ist wirkungslos.
# ---------------------------------------------------------------------------
operator_is_production() { [[ "${NODE_ENV:-production}" == "production" ]]; }

# Gemeinsamer Hinweis fuer das Gate und die doctor-Zeile: wie eine Installation
# auf den Release-Kanal wechselt (docs/operations/release.md, Abschnitt 2.3).
production_release_channel_hint() {
  printf '%s' "Produktion wird nur ueber den Release-Kanal mit signiertem Update-Manifest und CI-geprueften Registry-Images aktualisiert. Wechsel: in .env TAXTRONIK_DEPLOY_CHANNEL=release, TAXTRONIK_IMAGE_PREFIX=${TAXTRONIK_RELEASE_IMAGE_PREFIX_DEFAULT}, TAXTRONIK_VERSION=<veroeffentlichtes Release X.Y.Z> sowie UPDATE_MANIFEST_URL/UPDATE_PUBLIC_KEY setzen, danach ./taxtronik update (docs/operations/release.md, Abschnitt 2.3)."
}

# Gate am Anfang von deploy/update, vor jeder Seitenwirkung (auch vor der
# .env-Vervollstaendigung). NODE_ENV wird in der Rangfolge gelesen, die
# load_env anschliessend herstellt: .env vor Prozess-ENV, sonst Produktion.
# Ein ungueltiger Kanal faellt hier nicht durch, sondern wird von
# prepare_env_interactive mit eigener Meldung abgewiesen.
refuse_source_channel_in_production() {
  local operation="$1" node_env channel
  node_env="$(get_env NODE_ENV)"
  [[ "${node_env:-${NODE_ENV:-production}}" == "production" ]] || return 0
  channel="$(deployment_channel)" || return 0
  [[ "$channel" == "source" ]] || return 0
  die "$operation verweigert: TAXTRONIK_DEPLOY_CHANNEL=source ist in Produktion nicht zulaessig. $(production_release_channel_hint) Es wurde nichts veraendert."
}

# rc 0: Datei nutzbar, Ausgabe = kanonischer Pfad. rc 1: nicht konfiguriert
# (Variable leer und Default-Datei fehlt). rc 2: konfiguriert, aber
# unbrauchbar, Ausgabe = Grund. Eine vorhandene Datei gilt immer als
# konfiguriert, auch wenn sie leer oder unsicher ist.
source_allowed_signers_file() {
  local configured path canonical root_canonical candidate mode owner
  configured="${TAXTRONIK_SOURCE_ALLOWED_SIGNERS:-$(get_env TAXTRONIK_SOURCE_ALLOWED_SIGNERS)}"
  path="${configured:-$TAXTRONIK_SOURCE_ALLOWED_SIGNERS_DEFAULT}"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    [[ -n "$configured" ]] || return 1
    printf '%s fehlt' "$path"
    return 2
  fi
  [[ "$path" == /* ]] || { printf '%s ist kein absoluter Pfad' "$path"; return 2; }
  canonical="$(readlink -f -- "$path" 2>/dev/null || true)"
  root_canonical="$(readlink -f -- "$ROOT" 2>/dev/null || true)"
  [[ -n "$canonical" && -n "$root_canonical" ]] || { printf '%s ist nicht aufloesbar' "$path"; return 2; }
  # Nichts aus dem zu aktualisierenden Baum darf festlegen, wem er vertraut.
  if [[ "$canonical" == "$root_canonical" || "$canonical" == "$root_canonical/"* ]]; then
    printf '%s liegt im TaxTronik-Checkout und wird ignoriert' "$path"
    return 2
  fi
  [[ -f "$canonical" ]] || { printf '%s ist keine regulaere Datei' "$path"; return 2; }
  for candidate in "$canonical" "$(dirname -- "$canonical")"; do
    mode="$(stat -c '%a' -- "$candidate" 2>/dev/null || true)"
    owner="$(stat -c '%u' -- "$candidate" 2>/dev/null || true)"
    if [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 8#022) != 0 )); then
      printf '%s ist fuer Gruppe oder Andere beschreibbar' "$candidate"
      return 2
    fi
    [[ "$owner" == "0" || "$owner" == "$(id -u)" ]] || {
      printf '%s gehoert weder root noch dem Operator-Benutzer' "$candidate"
      return 2
    }
  done
  grep -Eq '^[[:space:]]*[^#[:space:]]' -- "$canonical" 2>/dev/null || {
    printf '%s enthaelt keinen Signer' "$path"
    return 2
  }
  printf '%s' "$canonical"
}

# Das fruehere Opt-out ist ohne Wirkung und wird nur noch gemeldet (rc 0 =
# irgendein Wert gesetzt). Es entscheidet nichts mehr und wird deshalb auch
# nicht mehr auf zulaessige Werte geprueft.
source_unsigned_update_opt_out_set() {
  [[ -n "${TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE:-$(get_env TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE)}" ]]
}

# Setzt _SOURCE_UPDATE_TRUST (signed | unsigned-nonproduction) und
# _SOURCE_UPDATE_SIGNERS. Bricht ab, wenn in diesem Zustand kein Source-Update
# zulaessig ist; in Produktion immer, auch mit konfigurierten Signern.
resolve_source_update_trust() {
  local signers="" signers_rc=0
  _SOURCE_UPDATE_TRUST=""
  _SOURCE_UPDATE_SIGNERS=""
  if operator_is_production; then
    die "Source-Update in Produktion verweigert, auch mit SSH-signiertem Ziel. $(production_release_channel_hint)"
  fi
  signers="$(source_allowed_signers_file)" || signers_rc=$?
  case "$signers_rc" in
    0)
      command -v ssh-keygen >/dev/null 2>&1 || \
        die "Source-Update verweigert: ssh-keygen (Paket openssh-client) fehlt; SSH-Signaturen koennen nicht geprueft werden."
      _SOURCE_UPDATE_TRUST="signed"
      _SOURCE_UPDATE_SIGNERS="$signers"
      ;;
    2)
      die "Source-Update verweigert: Signer-Datei unbrauchbar ($signers). TAXTRONIK_SOURCE_ALLOWED_SIGNERS muss auf eine root-/operator-eigene, nicht fremd beschreibbare Datei ausserhalb des Checkouts zeigen (docs/operations/release.md, Abschnitt 2.2)."
      ;;
    *)
      _SOURCE_UPDATE_TRUST="unsigned-nonproduction"
      ;;
  esac
}

# Vorabpruefung vor Pflichtbackup und Fetch: Ein Update, das spaeter ohnehin
# verweigert wuerde, veraendert keinen Betriebszustand.
assert_source_update_trust_ready() {
  resolve_source_update_trust
  case "$_SOURCE_UPDATE_TRUST" in
    signed)
      info "Source-Update ist an SSH-Signaturen gebunden (Signer: $_SOURCE_UPDATE_SIGNERS)." ;;
    unsigned-nonproduction)
      warn "NODE_ENV=${NODE_ENV:-}: keine Signer konfiguriert; Source-Update ausserhalb Produktion nur mit Warnung." ;;
  esac
  if source_unsigned_update_opt_out_set; then
    warn "TAXTRONIK_ALLOW_UNSIGNED_SOURCE_UPDATE ist wirkungslos und wird ignoriert; aus .env entfernen."
  fi
}

# Alle signaturrelevanten Git-Einstellungen werden pro Aufruf fest vorgegeben:
# Globale, System- und Repo-Konfiguration koennen weder Signer noch
# Pruefprogramm noch Mindestvertrauen aendern. OpenPGP/X.509 sind gesperrt,
# damit kein Schluesselbund des Operators eine Signatur bestaetigen kann.
source_signature_git() {
  local signers="$1" ssh_keygen="$2"
  shift 2
  git -C "$ROOT" \
    -c gpg.format=ssh \
    -c gpg.ssh.program="$ssh_keygen" \
    -c gpg.ssh.allowedSignersFile="$signers" \
    -c gpg.program=false \
    -c gpg.openpgp.program=false \
    -c gpg.x509.program=false \
    -c gpg.minTrustLevel=fully \
    "$@"
}

# rc 0, wenn der Commit selbst oder ein annotierter Tag, dessen direktes Ziel
# genau dieser Commit ist, gueltig signiert ist. Ausgabe = Pruefergebnis.
verify_source_commit_signature() {
  local target="$1" signers="$2" ssh_keygen commit_output="" output="" tag header
  ssh_keygen="$(command -v ssh-keygen 2>/dev/null || true)"
  [[ -n "$ssh_keygen" ]] || { printf 'ssh-keygen fehlt'; return 1; }
  if commit_output="$(source_signature_git "$signers" "$ssh_keygen" verify-commit "$target" 2>&1)"; then
    printf 'Commit %s: %s' "${target:0:12}" "$commit_output"
    return 0
  fi
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    header="$(git -C "$ROOT" cat-file tag "refs/tags/$tag" 2>/dev/null | head -n 2 || true)"
    [[ "$header" == "object $target"$'\n'"type commit" ]] || continue
    if output="$(source_signature_git "$signers" "$ssh_keygen" verify-tag "refs/tags/$tag" 2>&1)"; then
      printf 'Tag %s -> %s: %s' "$tag" "${target:0:12}" "$output"
      return 0
    fi
  done < <(git -C "$ROOT" tag --points-at "$target" 2>/dev/null || true)
  printf 'Commit %s: %s' "${target:0:12}" "${commit_output:-keine SSH-Signatur}"
  return 1
}

# Gibt den Commit eines Update-Ziels aus (rc 1 bei ungueltigem oder nicht
# aufloesbarem Ref). TAXTRONIK_UPDATE_REF darf keine Optionen-Syntax tragen.
source_update_target_commit() {
  local ref="$1" commit
  valid_git_ref "$ref" || return 1
  commit="$(git -C "$ROOT" rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null || true)"
  [[ "$commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  printf '%s' "$commit"
}

# Entscheidet vor dem Fast-forward, ob der geholte Ziel-Commit uebernommen und
# damit spaeter als Operator ausgefuehrt werden darf. Ein Ziel, das den Checkout
# nicht veraendert (identisch oder Vorfahr von HEAD), bringt keinen neuen Code.
authorize_source_update_target() {
  local current="$1" target="$2" result=""
  [[ "$current" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && "$target" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Source-Update-Pruefung braucht zwei gueltige Commits."
  if git -C "$ROOT" merge-base --is-ancestor "$target" "$current" >/dev/null 2>&1; then
    info "Kein neuer Source-Stand (${target:0:12} ist bereits enthalten); keine Signaturpruefung noetig."
    return 0
  fi
  resolve_source_update_trust
  case "$_SOURCE_UPDATE_TRUST" in
    signed)
      if result="$(verify_source_commit_signature "$target" "$_SOURCE_UPDATE_SIGNERS")"; then
        info "Signierter Source-Stand bestaetigt: $result"
        return 0
      fi
      printf '%s\n' "$result" >&2
      die "Source-Update verweigert: Ziel-Commit $target ist weder selbst noch ueber einen annotierten Tag auf genau diesen Commit von einem Signer aus $_SOURCE_UPDATE_SIGNERS SSH-signiert. Arbeitsbaum und Operator bleiben unveraendert."
      ;;
    unsigned-nonproduction)
      warn "NODE_ENV=${NODE_ENV:-}: Source-Stand $target wird ohne Signaturpruefung uebernommen (ausserhalb Produktion nur Warnung)."
      ;;
    *)
      die "Unbekannter Vertrauenszustand fuer Source-Updates: ${_SOURCE_UPDATE_TRUST:-leer}"
      ;;
  esac
}

operator_file_fingerprint() {
  local file="$1" digest
  if [[ ! -e "$file" ]]; then
    printf 'absent'
    return 0
  fi
  [[ -f "$file" && ! -L "$file" ]] || return 1
  digest="$(sha256sum -- "$file" 2>/dev/null | awk '{print $1}')" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

update_handoff_value() {
  local key="$1"
  [[ -f "$UPDATE_HANDOFF" && ! -L "$UPDATE_HANDOFF" ]] || return 0
  grep -E "^${key}=" "$UPDATE_HANDOFF" | head -n1 | cut -d= -f2- || true
}

update_handoff_has_single_key() {
  local key="$1"
  [[ "$(grep -Ec "^${key}=" "$UPDATE_HANDOFF" 2>/dev/null || true)" == "1" ]]
}

write_update_handoff() {
  local checkout_source_commit="$1" checkout_target_commit="$2"
  local transition_source_commit="$3" state_fingerprint pending_fingerprint tmp
  [[ "$checkout_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$checkout_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$checkout_source_commit" != "$checkout_target_commit" ]] || \
    die "Update-Handoff braucht zwei verschiedene gueltige Checkout-Commits."
  [[ -z "$transition_source_commit" || \
     "$transition_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Update-Handoff enthaelt einen ungueltigen Migrations-Quellcommit."
  git -C "$ROOT" merge-base --is-ancestor "$checkout_source_commit" "$checkout_target_commit" \
    >/dev/null 2>&1 || die "Update-Handoff verweigert: neuer Checkout ist kein Fast-forward-Nachfolger."
  state_fingerprint="$(operator_file_fingerprint "$STATE")" || \
    die "Installations-State kann nicht sicher an den Update-Handoff gebunden werden."
  pending_fingerprint="$(operator_file_fingerprint "$MIGRATION_PENDING")" || \
    die "Migrationsmarker kann nicht sicher an den Update-Handoff gebunden werden."
  if [[ "$pending_fingerprint" == "absent" ]]; then
    [[ "$transition_source_commit" == "$checkout_source_commit" ]] || \
      die "Update-Handoff hat keinen passenden Legacy-Migrations-Quellcommit."
  else
    [[ -z "$transition_source_commit" ]] || \
      die "Update-Handoff darf einen bestehenden Migrationsvertrag nicht durch einen Checkout-Commit ersetzen."
  fi

  tmp="$(mktemp "${UPDATE_HANDOFF}.tmp.XXXXXX")" || \
    die "Update-Handoff konnte nicht angelegt werden."
  {
    printf 'format=1\n'
    printf 'checkout_source_commit=%s\n' "$checkout_source_commit"
    printf 'checkout_target_commit=%s\n' "$checkout_target_commit"
    printf 'transition_source_commit=%s\n' "$transition_source_commit"
    printf 'state_sha256=%s\n' "$state_fingerprint"
    printf 'migration_pending_sha256=%s\n' "$pending_fingerprint"
    printf 'created_at_epoch=%s\n' "$(date -u +'%s')"
    printf 'created_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } >"$tmp"
  chmod 0600 "$tmp" || { rm -f -- "$tmp"; die "Update-Handoff konnte nicht gehaertet werden."; }
  mv -f -- "$tmp" "$UPDATE_HANDOFF"
  chmod 0600 "$UPDATE_HANDOFF" || die "Update-Handoff konnte nicht gehaertet werden."
}

update_handoff_is_valid() {
  local format checkout_source_commit checkout_target_commit transition_source_commit
  local expected_state expected_pending current_state current_pending checkout key mode owner
  local created_at_epoch now_epoch
  _TAXTRONIK_INTERNAL_VALIDATED_UPDATE_SOURCE_COMMIT=""
  [[ -f "$UPDATE_HANDOFF" && ! -L "$UPDATE_HANDOFF" ]] || return 1
  mode="$(stat -c '%a' "$UPDATE_HANDOFF" 2>/dev/null || true)"
  owner="$(stat -c '%u' "$UPDATE_HANDOFF" 2>/dev/null || true)"
  [[ "$mode" == "600" && "$owner" == "$(id -u)" ]] || return 1
  for key in format checkout_source_commit checkout_target_commit transition_source_commit \
    state_sha256 migration_pending_sha256 created_at_epoch created_at; do
    update_handoff_has_single_key "$key" || return 1
  done
  format="$(update_handoff_value format)"
  checkout_source_commit="$(update_handoff_value checkout_source_commit)"
  checkout_target_commit="$(update_handoff_value checkout_target_commit)"
  transition_source_commit="$(update_handoff_value transition_source_commit)"
  expected_state="$(update_handoff_value state_sha256)"
  expected_pending="$(update_handoff_value migration_pending_sha256)"
  created_at_epoch="$(update_handoff_value created_at_epoch)"
  [[ "$format" == "1" ]] || return 1
  [[ "$checkout_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$checkout_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && \
     "$checkout_source_commit" != "$checkout_target_commit" ]] || return 1
  [[ -z "$transition_source_commit" || \
     "$transition_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  [[ "$expected_state" == "absent" || "$expected_state" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$expected_pending" == "absent" || "$expected_pending" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$created_at_epoch" =~ ^[0-9]{10}$ ]] || return 1
  now_epoch="$(date -u +'%s')"
  [[ "$now_epoch" =~ ^[0-9]{10}$ ]] || return 1
  (( 10#$now_epoch >= 10#$created_at_epoch && \
     10#$now_epoch - 10#$created_at_epoch <= 900 )) || return 1
  if [[ "$expected_pending" == "absent" ]]; then
    [[ "$transition_source_commit" == "$checkout_source_commit" ]] || return 1
  else
    [[ -z "$transition_source_commit" ]] || return 1
  fi
  checkout="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$checkout" == "$checkout_target_commit" ]] || return 1
  git -C "$ROOT" merge-base --is-ancestor "$checkout_source_commit" "$checkout_target_commit" \
    >/dev/null 2>&1 || return 1
  current_state="$(operator_file_fingerprint "$STATE")" || return 1
  current_pending="$(operator_file_fingerprint "$MIGRATION_PENDING")" || return 1
  [[ "$current_state" == "$expected_state" && "$current_pending" == "$expected_pending" ]] || return 1
  _TAXTRONIK_INTERNAL_VALIDATED_UPDATE_SOURCE_COMMIT="$transition_source_commit"
}

clear_update_handoff() {
  [[ ! -e "$UPDATE_HANDOFF" ]] || rm -f -- "$UPDATE_HANDOFF"
}

continue_update_after_checkout() {
  # package.json/Workspace-Exports des neuen Checkouts muessen vor jedem
  # weiteren Host-pnpm-Kommando in node_modules gespiegelt sein. Andernfalls
  # blockiert `verifyDepsBeforeRun: error` erst spaet im Readiness-Gate.
  ensure_host_tool_deps
  # .env ggfs. aus dem aktualisierten Stand neu vervollstaendigen (Prod-Defaults,
  # fehlende Secrets, NEXTAUTH_URL) — wie bei deploy ohne Hand-Editiererei.
  prepare_env_interactive
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
  # Ein Registry-Vertrag wird nach dem Prozess-Handoff erneut signiert
  # verifiziert. Seine nur im alten Prozess gesetzten Digest-/Commit-Variablen
  # duerfen niemals ungeprueft ueber Prozessgrenzen weitergereicht werden.
  prepare_release_contract
  # Der neue Checkout kann auch die Infra-Definition erweitert haben.
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  provide_images
  provide_traefik_for_deploy
  provide_signal_for_deploy update
  run_migrations
  start_signal_for_deploy || die "Update abgebrochen: verwaltetes Signal ist nicht bereit."
  start_apps_for_activation deploy "$(image_tag)"
  smoke_health || die "Update fehlgeschlagen: Anwendung ist nicht vollstaendig healthy; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  smoke_public_frontend || die "Update fehlgeschlagen: verwaltetes Traefik/TLS ist nicht oeffentlich bereit; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  deploy_readiness || die "Update fehlgeschlagen: Produktivkonfiguration ist nicht bereit; letzter erfolgreicher Stand bleibt in $STATE vermerkt."
  finalize_release_contract
  info "Update fertig. Version: $(image_tag)"
}

# Wird erst nach dem Fast-forward erreicht, also nur fuer einen signiert
# verifizierten Stand (Release-Manifest bzw. ausserhalb Produktion die
# S-04-Signaturpruefung oder ein dort nur gewarnter Source-Stand).
reexec_updated_operator() {
  info "Aktualisierten Operator laden und Update automatisch fortsetzen"
  # shellcheck disable=SC2093 # exec ersetzt den Prozess bewusst; die greift nur bei gesetztem execfail
  exec "$ROOT/taxtronik" update
  die "Aktualisierter Operator konnte nicht gestartet werden."
}

cmd_update() {
  require_cmd docker; require_cmd node; require_cmd curl; require_cmd git
  require_cmd sha256sum; require_cmd stat
  local _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT=""
  local checkout_source_commit checkout_target_commit

  # Produktion nur ueber den Release-Kanal: vor Handoff, .env-Vorbereitung,
  # Pflichtbackup, Fetch, Build und Migration.
  refuse_source_channel_in_production Update

  # Der alte Prozess hat Backup und Fast-forward bereits sicher abgeschlossen.
  # Nur ein exakt an Checkout, State und Migrationsmarker gebundener 0600-Marker
  # darf die Wiederholung des Pflichtbackups ueberspringen. Der Marker wird vor
  # allen weiteren Seiteneffekten verbraucht; ein spaeterer Retry startet daher
  # wieder mit einem frischen Backup.
  if [[ -e "$UPDATE_HANDOFF" ]]; then
    if update_handoff_is_valid; then
      _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT="${_TAXTRONIK_INTERNAL_VALIDATED_UPDATE_SOURCE_COMMIT:-}"
      unset _TAXTRONIK_INTERNAL_VALIDATED_UPDATE_SOURCE_COMMIT
      clear_update_handoff
      info "Sicheren Update-Handoff uebernommen; neuer Operator setzt denselben Lauf fort"
      continue_update_after_checkout
      return 0
    fi
    warn "Veralteten oder ungueltigen Update-Handoff verworfen; Update beginnt sicher mit neuem Pflichtbackup."
    clear_update_handoff
  fi

  checkout_source_commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$checkout_source_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Aktueller Checkout-Commit kann vor dem Update nicht bestimmt werden."

  # Vor dem ersten Forward-Versuch kann ein Legacy-State noch keinen Commit
  # enthalten. Den aktuellen Checkout nur ohne bestehenden Pending-Vertrag als
  # Quellbeweis erfassen; bei Retries bleibt der persistierte Marker massgeblich.
  if [[ ! -e "$MIGRATION_PENDING" ]]; then
    _TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT="$checkout_source_commit"
  fi

  # Das Pflichtbackup muss vollstaendig mit dem bisher installierten Checkout
  # und dessen Prisma-Client laufen. Neuer Anwendungscode darf das noch alte
  # DB-Schema vor dessen Migration nicht abfragen. Erst ein erfolgreiches
  # Backup autorisiert daher ueberhaupt fetch/merge und damit eine Aenderung des
  # Arbeitsbaums.
  prepare_env_interactive
  load_env
  prepare_source_version_for_checkout
  preflight_common; assert_production_env; require_release_version
  assert_no_database_restore_pending
  # Beide Kanaele klaeren ihren Vertrauensanker vor dem Pflichtbackup: Release
  # das signierte Manifest, Source die gepinnten SSH-Signer (S-04).
  if images_from_registry; then resolve_release_contract; else assert_source_update_trust_ready; fi
  start_infra
  wait_postgres_healthy
  sync_postgres_roles_from_env
  run_backup || die "Pflichtbackup fehlgeschlagen — Code und Arbeitsbaum bleiben unveraendert."

  info "Code auf den freigegebenen Stand aktualisieren (git ff-only)"
  # shellcheck disable=SC2164 # ops-lib.sh setzt set -e: ein cd-Fehler beendet das Update
  cd "$ROOT"
  local remote target_ref target_commit=""
  remote="$(deployment_git_remote)"
  if images_from_registry; then
    fetch_verified_release_tag "$TAXTRONIK_VERSION" "$UPDATE_COMMIT_SHA"
    # Der globale umask 077 schuetzt Operator-Secrets, darf aber von Git neu
    # angelegte getrackte Quellen nicht auf 0600/0700 beschraenken: Docker COPY
    # wuerde diese Modi sonst in die non-root-Runtime-Images uebernehmen.
    (umask 022; git merge --ff-only "$UPDATE_COMMIT_SHA")
  else
    git fetch "$remote" || die "Git-Fetch von $remote fehlgeschlagen; Arbeitsbaum bleibt unveraendert."
    target_ref="${TAXTRONIK_UPDATE_REF:-$remote/main}"
    target_commit="$(source_update_target_commit "$target_ref")" || \
      die "Update-Ziel '$target_ref' ist ungueltig oder nach dem Fetch kein eindeutiger Commit."
    # S-04: Die Signaturentscheidung faellt fuer den exakten Ziel-Commit vor dem
    # Fast-forward und damit vor jeder Ausfuehrung des neuen Operator-Codes.
    # Gemergt wird genau der gepruefte Commit, nicht erneut der bewegliche Ref.
    authorize_source_update_target "$checkout_source_commit" "$target_commit"
    (umask 022; git merge --ff-only "$target_commit") || \
      die "Fast-forward auf ${target_commit} fehlgeschlagen (lokale Aenderungen oder kein Nachfolger); Operator bleibt unveraendert."
  fi
  checkout_target_commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$checkout_target_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || \
    die "Aktualisierter Checkout-Commit kann nicht bestimmt werden."
  if [[ -n "$target_commit" && "$checkout_target_commit" != "$checkout_source_commit" && \
        "$checkout_target_commit" != "$target_commit" ]]; then
    die "Checkout $checkout_target_commit ist nicht der gepruefte Ziel-Commit $target_commit; aktualisierter Operator wird nicht gestartet."
  fi
  if [[ "$checkout_target_commit" != "$checkout_source_commit" ]]; then
    write_update_handoff "$checkout_source_commit" "$checkout_target_commit" \
      "$_TAXTRONIK_INTERNAL_UPDATE_SOURCE_COMMIT"
    reexec_updated_operator
    return 0
  fi
  continue_update_after_checkout
}
