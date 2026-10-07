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

require_line package.json '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@12\.4\.1"' \
  "Root packageManager muss auf pnpm@12.4.1 gepinnt sein."

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
  "pmOnFail muss download sein, damit pnpm bei Bedarf die deklarierte Version laedt."
require_line pnpm-workspace.yaml "^savePrefix:[[:space:]]*''$" \
  "savePrefix muss leer sein, damit neu hinzugefuegte Dependencies exakt gepinnt werden."

# T-02: Die CRL- und Kettenhaertung liegt nicht mehr in einem Patch auf
# @simplewebauthn/server, sondern in @taxtronik/crypto/certificate-path. Web und
# Worker uebergeben der Bibliothek keine Wurzelzertifikate; nur so fuehrt 13.3.3
# selbst keine (upstream fail-open) Ketten- und CRL-Pruefung aus. Das belegen
# webauthn-library-contract.test.ts und fido-mds-library-contract.test.ts fuer
# genau diese Version, daher bleibt sie exakt gepinnt.
WEBAUTHN_PATH_CHECK='packages/crypto/src/certificate-path.ts'
# T-02-Folge: CRL-Abrufe nur an oeffentliche, gepinnte Adressen ohne Redirects.
WEBAUTHN_CRL_FETCH='packages/crypto/src/crl-fetch.ts'
WEBAUTHN_ATTESTATION='apps/web/src/server/auth/webauthn-attestation.ts'
WEBAUTHN_MDS_VERIFY='apps/worker/src/jobs/fido-mds-verify.ts'
require_line apps/web/package.json '"@simplewebauthn/server"[[:space:]]*:[[:space:]]*"13\.3\.3"' \
  "SimpleWebAuthn Server muss exakt auf 13.3.3 gepinnt bleiben (Vertrag der vorgeschalteten Ketten-/CRL-Pruefung)."
# P-23: Der Worker-Job fido-mds-refresh prueft den FIDO-MDS-BLOB mit derselben
# Version und derselben Ketten-/CRL-Pruefung (fail-closed).
require_line apps/worker/package.json '"@simplewebauthn/server"[[:space:]]*:[[:space:]]*"13\.3\.3"' \
  "SimpleWebAuthn Server muss auch im Worker exakt auf 13.3.3 gepinnt bleiben."

fixed_count() {
  grep -Fc "$2" "$1" 2>/dev/null || true
}

if [ ! -f "$WEBAUTHN_PATH_CHECK" ] || [ ! -f "$WEBAUTHN_ATTESTATION" ] || [ ! -f "$WEBAUTHN_MDS_VERIFY" ]; then
  error "Die WebAuthn-Ketten-/CRL-Pruefung ($WEBAUTHN_PATH_CHECK, $WEBAUTHN_ATTESTATION, $WEBAUTHN_MDS_VERIFY) fehlt."
elif [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate revocation list could not be downloaded'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate revocation list could not be parsed'")" -ne 1 ]; then
  error "Die CRL-Pruefung muss Download- und Parsefehler fail-closed behandeln."
elif [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate revocation list could not be verified'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate issuer is required to verify its revocation list'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "redirect: 'error'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" 'const MAX_CACHE_ENTRIES = 256')" -ne 1 ]; then
  error "Die CRL-Pruefung muss an Aussteller, Signatur, Freshness, Redirect-Sperre und begrenzten Cache gebunden sein."
elif [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate issuer is not an authorized certificate authority'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new Error('Certificate path did not terminate at the selected trust anchor'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "throw new InvalidCertificatePathError('Certificate path has no trust anchor')")" -ne 1 ]; then
  error "Die Kettenpruefung muss strikte CA-Constraints, eine exakte Trust Anchor und mindestens eine Trust Anchor verlangen."
elif [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" 'data.verify({ publicKey: issuer.publicKey })')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" 'distributionPoints.length !== 1')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" 'point.reasons !== undefined')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "const DELTA_CRL_INDICATOR_OID = '2.5.29.27'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "const ISSUING_DISTRIBUTION_POINT_OID = '2.5.29.28'")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "const FRESHEST_CRL_OID = '2.5.29.46'")" -ne 1 ]; then
  error "Die CRL-Pruefung muss an den CRL-Signaturalgorithmus sowie genau eine unpartitionierte Voll-CRL gebunden sein."
elif [ ! -f "$WEBAUTHN_CRL_FETCH" ] || \
     [ "$(fixed_count "$WEBAUTHN_PATH_CHECK" "await fetchCrl(crlURL, { signal, redirect: 'error' })")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_CRL_FETCH" 'lookup: pinnedLookup(bareHostname(url), addresses),')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_CRL_FETCH" 'if (status >= 300 && status < 400) {')" -ne 1 ]; then
  error "Der CRL-Abruf muss oeffentliche Adressen erzwingen, die Verbindung pinnen und Redirects abweisen ($WEBAUTHN_CRL_FETCH)."
elif [ "$(fixed_count "$WEBAUTHN_ATTESTATION" 'if (!extension || extension.critical) {')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_ATTESTATION" 'return { ...statement, attestationRootCertificates: [] };')" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_ATTESTATION" 'await validateCertificatePath(chain, roots, { signal: input.signal });')" -ne 1 ]; then
  error "Die Attestationspruefung muss die nichtkritische Zertifikat-AAGUID verlangen, SimpleWebAuthn ohne Wurzeln aufrufen und die Kette selbst pruefen."
elif [ "$(fixed_count "$WEBAUTHN_MDS_VERIFY" "SettingsService.setRootCertificates({ identifier: 'mds', certificates: [] });")" -ne 1 ] || \
     [ "$(fixed_count "$WEBAUTHN_MDS_VERIFY" 'await validateCertificatePath(signerChain, FIDO_MDS_TRUST_ANCHORS, { signal });')" -ne 1 ]; then
  error "Der MDS-Abruf muss SimpleWebAuthn ohne MDS-Wurzeln aufrufen und die Signaturkette selbst gegen die gepinnten Anker pruefen."
fi

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
source-map-js@1.2.2
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
tesseract.js@7.0.0=false
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
