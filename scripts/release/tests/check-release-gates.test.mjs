import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkReleaseGates } from '../check-release-gates.mjs';

const workflows = {
  release: readFileSync('.forgejo/workflows/release.yml', 'utf8'),
  ci: readFileSync('.forgejo/workflows/ci.yml', 'utf8'),
  security: readFileSync('.forgejo/workflows/security.yml', 'utf8'),
};

assert.equal(checkReleaseGates(workflows), true);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        'needs: [preflight, full-ci, security-gate]',
        'needs: preflight',
      ),
    }),
  /release muss preflight, full-ci und security-gate benötigen/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        '    needs: release\n    runs-on: ubuntu-latest',
        "    needs: release\n    if: vars.UPDATE_MANIFEST_REPO != ''\n    runs-on: ubuntu-latest",
      ),
    }),
  /manifest: job-weites if ist als Gate-Bypass verboten/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      ci: workflows.ci.replace('  workflow_call:\n', ''),
    }),
  /ci\.yml: on\.workflow_call fehlt/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('push --dry-run', 'status'),
    }),
  /preflight prüft das Manifest-Schreibrecht nicht/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('--worker-image-digest', '--legacy-worker-digest'),
    }),
  /Manifest-Aufruf ohne --worker-image-digest/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        'group: release-promotion',
        'group: release-${{ github.ref }}',
      ),
    }),
  /globale, nicht-abbrechende Release-Serialisierung fehlt/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('docker manifest inspect', 'docker image inspect'),
    }),
  /schützt vorhandene SemVer-Image-Tags nicht fail-closed vor Überschreiben/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        'Registry-Status fuer $ref ist nicht eindeutig',
        'Registry-Fehler wird ignoriert',
      ),
    }),
  /schützt vorhandene SemVer-Image-Tags nicht fail-closed vor Überschreiben/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        '${{ steps.meta.outputs.prefix }}/web:${{ steps.meta.outputs.version }}',
        '${{ steps.meta.outputs.prefix }}/web:latest',
      ),
    }),
  /keinen veraenderlichen latest-Tag/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('GIT_ASKPASS_REQUIRE=force', 'GIT_ASKPASS_REQUIRE=never'),
    }),
  /preflight: Manifest-Git-Zugriff muss Askpass erzwingen/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace(
        '"https://x@${REPO_NOSCHEME}"',
        '"https://x:${UPDATE_MANIFEST_TOKEN}@${REPO_NOSCHEME}"',
      ),
    }),
  /preflight: Manifest-Token darf nicht in einer Git-URL stehen/,
);

process.stdout.write('12 release-gate structure tests passed.\n');
