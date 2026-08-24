// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkReleaseGates } from '../check-release-gates.mjs';

const workflows = {
  release: readFileSync('.forgejo/workflows/release.yml', 'utf8'),
  ci: readFileSync('.forgejo/workflows/ci.yml', 'utf8'),
  security: readFileSync('.forgejo/workflows/security.yml', 'utf8'),
  smoke: readFileSync('scripts/release/smoke-release-images.sh', 'utf8'),
  composeCi: readFileSync('infra/compose/docker-compose.ci.yml', 'utf8'),
};

assert.equal(checkReleaseGates(workflows), true);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      smoke: workflows.smoke.replace('--project-name "$SMOKE_PROJECT_NAME"', ''),
    }),
  /eindeutigen Compose-Projektnamen/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      smoke: workflows.smoke.replace('-f "$CI"', ''),
    }),
  /Forgejo-Host-Daemon-Bind-Mounts/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      composeCi: workflows.composeCi.replace(
        'COPY postgres-init.sh /docker-entrypoint-initdb.d/01-init.sh',
        'RUN true',
      ),
    }),
  /Postgres-Init und n8n-Workflows/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      composeCi: workflows.composeCi.replace('\nvolumes:\n  n8n_data:\n', '\n'),
    }),
  /Postgres-Init und n8n-Workflows/,
);

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
      release: workflows.release.replace('$GITHUB_ACTOR', 'x'),
    }),
  /preflight: Manifest-Git-Zugriff muss den Forgejo-Akteur als Benutzernamen verwenden/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      ci: workflows.ci.replace('needs: restore', 'needs: quality'),
    }),
  /servicebasierte Jobs muessen fuer Forgejo-Host-Netz-Ports serialisiert bleiben/,
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

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('bash scripts/release/smoke-release-images.sh', 'true'),
    }),
  /nicht vor dem Registry-Push als Stack getestet/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replace('--format cyclonedx', '--format table'),
    }),
  /keine CycloneDX-SBOMs/,
);

assert.throws(
  () =>
    checkReleaseGates({
      ...workflows,
      release: workflows.release.replaceAll(
        '--docker-host "$TRIVY_DOCKER_HOST"',
        '--docker-host unix:///var/run/docker.sock',
      ),
    }),
  /Trivy muss im Forgejo-Job nativ/,
);

process.stdout.write('21 release-gate structure tests passed.\n');
