#!/usr/bin/env sh
# =============================================================================
# Guard: pnpm/npm supply-chain policy.
#
# This runs before dependency installation in CI/release jobs. It intentionally
# has no npm dependencies, so a poisoned package graph cannot affect the guard.
# =============================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
TMP_DIR="${TMPDIR:-/tmp}/taxtronik-pnpm-supply-chain-$$"
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

error() {
  echo "FEHLER: $*" >&2
  FAIL=1
}

require_line() {
  file="$1"
  pattern="$2"
  message="$3"
  if ! grep -Eq "$pattern" "$file"; then
    error "$message"
  fi
}

require_line package.json '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@11\.20\.0"' \
  "Root packageManager muss auf pnpm@11.20.0 gepinnt sein."

require_line pnpm-workspace.yaml '^minimumReleaseAge:[[:space:]]*10080([[:space:]]*#.*)?$' \
  "minimumReleaseAge muss auf 10080 Minuten (7 Tage) stehen."
require_line pnpm-workspace.yaml '^minimumReleaseAgeStrict:[[:space:]]*true$' \
  "minimumReleaseAgeStrict muss true sein."
require_line pnpm-workspace.yaml '^minimumReleaseAgeIgnoreMissingTime:[[:space:]]*false$' \
  "minimumReleaseAgeIgnoreMissingTime muss false sein."
require_line pnpm-workspace.yaml '^trustLockfile:[[:space:]]*false$' \
  "trustLockfile muss false sein, damit Lockfile-Eintraege erneut geprueft werden."
require_line pnpm-workspace.yaml '^trustPolicy:[[:space:]]*no-downgrade$' \
  "trustPolicy muss no-downgrade sein."
require_line pnpm-workspace.yaml '^blockExoticSubdeps:[[:space:]]*true$' \
  "blockExoticSubdeps muss true sein."
require_line pnpm-workspace.yaml '^strictDepBuilds:[[:space:]]*true$' \
  "strictDepBuilds muss true sein."
require_line pnpm-workspace.yaml '^dangerouslyAllowAllBuilds:[[:space:]]*false$' \
  "dangerouslyAllowAllBuilds muss false sein."
require_line pnpm-workspace.yaml '^sideEffectsCache:[[:space:]]*false$' \
  "sideEffectsCache muss false sein."
require_line pnpm-workspace.yaml '^verifyDepsBeforeRun:[[:space:]]*error$' \
  "verifyDepsBeforeRun muss error sein."
require_line pnpm-workspace.yaml '^pmOnFail:[[:space:]]*download$' \
  "pmOnFail muss download sein, damit Corepack die deklarierte pnpm-Version laedt."
require_line pnpm-workspace.yaml "^savePrefix:[[:space:]]*''$" \
  "savePrefix muss leer sein, damit neu hinzugefuegte Dependencies exakt gepinnt werden."

awk '
  /^minimumReleaseAgeExclude:/ { in_block = 1; next }
  in_block && /^[^[:space:]#][^:]*:/ { exit }
  in_block && /^[[:space:]]*-[[:space:]]*/ {
    line = $0
    sub(/^[[:space:]]*-[[:space:]]*/, "", line)
    gsub(/^[[:space:]'\''"]+|[[:space:]'\''"]+$/, "", line)
    print line
  }
' pnpm-workspace.yaml | sort > "$TMP_DIR/min-age-exclude-actual"

cat > "$TMP_DIR/min-age-exclude-expected" <<'EOF'
brace-expansion@1.1.18 || 5.0.9
deepmerge-ts@8.0.0
nanoid@3.3.18
nodemailer@9.0.1
postcss@8.5.23
undici@8.9.0
EOF
sort -o "$TMP_DIR/min-age-exclude-expected" "$TMP_DIR/min-age-exclude-expected"

if ! diff -u "$TMP_DIR/min-age-exclude-expected" "$TMP_DIR/min-age-exclude-actual" > "$TMP_DIR/min-age-exclude-diff"; then
  error "minimumReleaseAgeExclude wurde geaendert. Neue Quarantaene-Ausnahmen brauchen expliziten Security-Review:"
  cat "$TMP_DIR/min-age-exclude-diff" >&2
fi

awk '
  /^trustPolicyExclude:/ { in_block = 1; next }
  in_block && /^[^[:space:]#][^:]*:/ { exit }
  in_block && /^[[:space:]]*-[[:space:]]*/ {
    line = $0
    sub(/^[[:space:]]*-[[:space:]]*/, "", line)
    gsub(/^[[:space:]'\''"]+|[[:space:]'\''"]+$/, "", line)
    print line
  }
' pnpm-workspace.yaml | sort > "$TMP_DIR/trust-exclude-actual"

cat > "$TMP_DIR/trust-exclude-expected" <<'EOF'
next-auth@5.0.0-beta.32
semver@6.3.1
tinyexec@1.2.2
EOF
sort -o "$TMP_DIR/trust-exclude-expected" "$TMP_DIR/trust-exclude-expected"

if ! diff -u "$TMP_DIR/trust-exclude-expected" "$TMP_DIR/trust-exclude-actual" > "$TMP_DIR/trust-exclude-diff"; then
  error "trustPolicyExclude wurde geaendert. Neue Trust-Ausnahmen brauchen expliziten Security-Review:"
  cat "$TMP_DIR/trust-exclude-diff" >&2
fi

awk '
  /^allowBuilds:/ { in_block = 1; next }
  in_block && /^[^[:space:]#][^:]*:/ { exit }
  in_block && /^[[:space:]]*[^#[:space:]][^:]*:[[:space:]]*(true|false)[[:space:]]*$/ {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    split(line, parts, ":")
    key = parts[1]
    value = parts[2]
    gsub(/^[[:space:]'\''"]+|[[:space:]'\''"]+$/, "", key)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    print key "=" value
  }
' pnpm-workspace.yaml | sort > "$TMP_DIR/allow-actual"

cat > "$TMP_DIR/allow-expected" <<'EOF'
@prisma/client=true
@prisma/engines=true
canvas=false
esbuild=true
msgpackr-extract=true
prisma=true
sharp=true
unrs-resolver=true
EOF
sort -o "$TMP_DIR/allow-expected" "$TMP_DIR/allow-expected"

if ! diff -u "$TMP_DIR/allow-expected" "$TMP_DIR/allow-actual" > "$TMP_DIR/allow-diff"; then
  error "allowBuilds wurde geaendert. Neue Install-Scripts brauchen expliziten Security-Review:"
  cat "$TMP_DIR/allow-diff" >&2
fi

if ! command -v node >/dev/null 2>&1; then
  error "node fehlt; package.json Dependency-Specifier koennen nicht geprueft werden."
  : > "$TMP_DIR/manifest-exotic"
else
  node > "$TMP_DIR/manifest-exotic" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const dirs = ['apps', 'packages'];
const files = ['package.json'];

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    files.push(path.join(dir, entry.name, 'package.json'));
  }
}

const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const exotic = /^(git\+|git:|git:\/\/|github:|gitlab:|bitbucket:|https?:\/\/)/;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const section of sections) {
    const deps = json[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (typeof specifier === 'string' && exotic.test(specifier)) {
        console.log(`${path.relative(root, path.resolve(file))}:${section}:${name}:${specifier}`);
      }
    }
  }
}
NODE
fi

if [ -s "$TMP_DIR/manifest-exotic" ]; then
  error "Package-Manifeste duerfen keine Git-/URL-basierten Dependency-Specifier enthalten:"
  cat "$TMP_DIR/manifest-exotic" >&2
fi

grep -nE '(git\+|git://|github:|gitlab:|bitbucket:|tarball:|resolution:.*https?://|specifier:.*https?://|version:.*https?://)' \
  pnpm-lock.yaml > "$TMP_DIR/lockfile-exotic" || true

if [ -s "$TMP_DIR/lockfile-exotic" ]; then
  error "pnpm-lock.yaml enthaelt Git-/URL-/Tarball-Quellen:"
  cat "$TMP_DIR/lockfile-exotic" >&2
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "OK: pnpm supply-chain policy ist gehaertet und der Lockfile enthaelt keine exotischen Quellen."
