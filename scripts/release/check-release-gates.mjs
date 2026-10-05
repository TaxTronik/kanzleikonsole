#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jobBlock(workflow, jobName) {
  const marker = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, 'm');
  const match = marker.exec(workflow);
  invariant(match, `Job ${jobName} fehlt`);
  const start = match.index;
  const remainder = workflow.slice(start + match[0].length);
  const nextJob = /^ {2}[A-Za-z0-9_-]+:\s*$/m.exec(remainder);
  return workflow.slice(start, nextJob ? start + match[0].length + nextJob.index : undefined);
}

function topLevelBlock(workflow, name) {
  const marker = new RegExp(`^${escapeRegExp(name)}:\\s*$`, 'm');
  const match = marker.exec(workflow);
  invariant(match, `Top-Level-Block ${name} fehlt`);
  const start = match.index;
  const remainder = workflow.slice(start + match[0].length);
  const nextBlock = /^[A-Za-z][A-Za-z0-9_-]*:\s*$/m.exec(remainder);
  return workflow.slice(start, nextBlock ? start + match[0].length + nextBlock.index : undefined);
}

function indentedSection(block, key) {
  const match = new RegExp(`^ {4}${key}:\\s*$`, 'm').exec(block);
  if (!match) return '';
  const rest = block.slice(match.index + match[0].length);
  const end = /^ {4}\S/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function serviceHostPorts(block) {
  return [
    ...indentedSection(block, 'services').matchAll(/^\s+-\s*['"]?(\d+):(\d+)['"]?\s*$/gm),
  ].map((match) => ({ host: match[1], container: match[2] }));
}

// Forgejo startet Services eines wiederverwendeten Workflows im Host-Netz. Die
// servicebasierten Jobs laufen parallel nach quality und brauchen deshalb
// eindeutige Host-Ports. PostgreSQL hoert per PGPORT genau auf dem Port, den
// Mapping, Job-env und DATABASE_URL des Jobs verwenden.
const CI_SERVICE_JOBS = ['db', 'restore', 'upgrade-path', 'e2e-paranoid'];

function requireIsolatedServicePorts(ci, jobs) {
  const owners = new Map();
  for (const job of jobs) {
    for (const { host } of serviceHostPorts(jobBlock(ci, job))) {
      invariant(
        !owners.has(host),
        `ci.yml: Host-Port ${host} wird von ${owners.get(host)} und ${job} belegt; parallele Jobs kollidieren im Host-Netz`,
      );
      owners.set(host, job);
    }
  }
  for (const job of CI_SERVICE_JOBS) {
    const block = jobBlock(ci, job);
    invariant(
      /^ {4}needs: (?:quality|\[[^\]\n]*\bquality\b[^\]\n]*\])\s*$/m.test(block),
      `ci.yml: ${job} muss quality benoetigen`,
    );
    const port = /^\s+PGPORT: '?(\d+)'?\s*$/m.exec(indentedSection(block, 'services'))?.[1];
    const env = indentedSection(block, 'env');
    invariant(
      port !== undefined &&
        serviceHostPorts(block).some(
          ({ host, container }) => host === port && container === port,
        ) &&
        new RegExp(`^ {6}PGPORT: '?${port}'?\\s*$`, 'm').test(env) &&
        new RegExp(`^ {6}DATABASE_URL: \\S+@localhost:${port}/`, 'm').test(env),
      `ci.yml: ${job} muss PostgreSQL per PGPORT auf einem eigenen Host-Port betreiben und PGPORT/DATABASE_URL im Job-env darauf ausrichten`,
    );
  }
}

function requireWorkflowCall(workflow, name) {
  const onBlock = /^on:\s*$([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9_-]*:\s*$)/m.exec(workflow)?.[1] ?? '';
  invariant(/^ {2}workflow_call:\s*$/m.test(onBlock), `${name}: on.workflow_call fehlt`);
}

/**
 * Beide Muster waren auf exakt vier Leerzeichen verankert, trafen also nur die
 * Job-Ebene. Ein `continue-on-error: true` am SCHRITT (acht Leerzeichen) —
 * etwa am Trivy- oder Immutability-Schritt — passierte folgenlos, obwohl es
 * das Gate genauso aushebelt. Deshalb jetzt auf jeder Einrueckung.
 *
 * `if:` wird bewusst differenziert: `always()`/`failure()` fuegen einem Gate
 * etwas hinzu (Nachweis-Upload auch im Fehlerfall) und sind zulaessig. Jede
 * andere Bedingung kann einen Pruefschritt ueberspringen und ist damit ein
 * Bypass.
 */
const ALLOWED_STEP_CONDITIONS = /^(always|failure)\(\)$/;

function forbidJobBypass(block, name) {
  invariant(!/^ {4}if:/m.test(block), `${name}: job-weites if ist als Gate-Bypass verboten`);
  invariant(
    !/^\s+continue-on-error:/m.test(block),
    `${name}: continue-on-error ist als Gate-Bypass verboten (auch auf Schritt-Ebene)`,
  );
  for (const m of block.matchAll(/^\s+if:[ \t]*(.+?)\s*$/gm)) {
    const condition = m[1].replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
    invariant(
      ALLOWED_STEP_CONDITIONS.test(condition),
      `${name}: bedingter Schritt "if: ${m[1]}" kann ein Gate ueberspringen — nur always()/failure() sind zulaessig`,
    );
  }
}

function requireAskpass(block, name) {
  invariant(
    /chmod 0700 "\$ASKPASS"/.test(block) &&
      /^\s*export [^\n]*GIT_ASKPASS="\$ASKPASS"/m.test(block) &&
      /^\s*export [^\n]*GIT_ASKPASS_REQUIRE=force/m.test(block) &&
      /^\s*export [^\n]*GIT_TERMINAL_PROMPT=0/m.test(block) &&
      /trap '[^'\n]*rm -f "\$ASKPASS"[^'\n]*' EXIT/.test(block),
    `${name}: Manifest-Git-Zugriff muss Askpass erzwingen und sicher aufraeumen`,
  );
  invariant(
    !/https?:\/\/[^\r\n]*UPDATE_MANIFEST_TOKEN/.test(block),
    `${name}: Manifest-Token darf nicht in einer Git-URL stehen`,
  );
  invariant(
    /\*Username\*\)[^\r\n]*\$GITHUB_ACTOR/.test(block),
    `${name}: Manifest-Git-Zugriff muss den Forgejo-Akteur als Benutzernamen verwenden`,
  );
}

export function checkReleaseGates({ release, ci, security, smoke, composeCi }) {
  invariant(
    /docker compose --project-name "\$SMOKE_PROJECT_NAME"/.test(smoke) &&
      /down -v --remove-orphans/.test(smoke),
    'Release-Image-Smoke braucht einen eindeutigen Compose-Projektnamen vor destruktivem Cleanup',
  );
  invariant(
    /docker-compose\.ci\.yml/.test(smoke) &&
      /COMPOSE=\([^\n]*-f "\$CI"/.test(smoke) &&
      /"\$\{COMPOSE\[@\]\}" build postgres seaweedfs seaweedfs-init clamav n8n/.test(smoke) &&
      /TAXTRONIK_SMOKE_POSTGRES_IMAGE/.test(smoke) &&
      /TAXTRONIK_SMOKE_N8N_IMAGE/.test(smoke) &&
      /app:\s*\n\s+image:[^\n]+\n\s+volumes: !override/.test(smoke) &&
      /n8n:\s*\n\s+volumes: !override/.test(smoke),
    'Release-Image-Smoke muss Forgejo-Host-Daemon-Bind-Mounts durch gebaute Config-Images und Named Volumes ersetzen',
  );
  invariant(
    /postgres:\s*\n\s+build:[\s\S]*?COPY postgres-init\.sh \/docker-entrypoint-initdb\.d\/01-init\.sh[\s\S]*?volumes: !override[\s\S]*?- postgres_data:\/var\/lib\/postgresql/.test(
      composeCi,
    ) &&
      /n8n:\s*\n\s+build:[\s\S]*?COPY --chown=node:node workflows \/workflows[\s\S]*?volumes: !override[\s\S]*?- n8n_data:\/home\/node\/\.n8n/.test(
        composeCi,
      ) &&
      /^volumes:\s*$[\s\S]*?^ {2}n8n_data:\s*$/m.test(composeCi),
    'CI-Compose muss Postgres-Init und n8n-Workflows ohne Host-Workspace-Bind-Mounts bereitstellen',
  );
  requireWorkflowCall(ci, 'ci.yml');
  requireWorkflowCall(security, 'security.yml');
  invariant(
    /group: quality-\$\{\{ github\.ref \}\}/.test(ci),
    'ci.yml: eigener Concurrency-Präfix fehlt',
  );
  invariant(
    /group: security-\$\{\{ github\.ref \}\}/.test(security),
    'security.yml: eigener Concurrency-Präfix fehlt',
  );
  const releaseConcurrency = topLevelBlock(release, 'concurrency');
  invariant(
    /^ {2}group: release-promotion\s*$/m.test(releaseConcurrency) &&
      /^ {2}cancel-in-progress: false\s*$/m.test(releaseConcurrency),
    'release.yml: globale, nicht-abbrechende Release-Serialisierung fehlt',
  );
  invariant(
    /grep -vx "\$CURRENT_TAG"/.test(ci),
    'ci.yml: Upgrade-Pfad schließt den aktuellen Release-Tag nicht aus',
  );
  const ciJobs = [
    'quality',
    'db',
    'restore',
    'upgrade-path',
    'e2e-paranoid',
    'e-rechnung',
    'deploy-readiness',
  ];
  for (const job of ciJobs) jobBlock(ci, job);
  requireIsolatedServicePorts(ci, ciJobs);
  for (const job of ['dependencies', 'secrets']) jobBlock(security, job);
  invariant(
    !/^\s+continue-on-error:/m.test(ci) && !/^\s+continue-on-error:/m.test(security),
    'wiederverwendbare Gate-Workflows duerfen continue-on-error nicht verwenden',
  );

  const preflight = jobBlock(release, 'preflight');
  const fullCi = jobBlock(release, 'full-ci');
  const securityGate = jobBlock(release, 'security-gate');
  const publish = jobBlock(release, 'release');
  const manifest = jobBlock(release, 'manifest');

  for (const [name, block] of [
    ['preflight', preflight],
    ['full-ci', fullCi],
    ['security-gate', securityGate],
    ['release', publish],
    ['manifest', manifest],
  ]) {
    forbidJobBypass(block, name);
  }

  invariant(/needs: preflight/.test(fullCi), 'full-ci muss preflight benötigen');
  invariant(
    /uses: \.\/\.forgejo\/workflows\/ci\.yml/.test(fullCi),
    'full-ci ruft ci.yml nicht auf',
  );
  invariant(/needs: preflight/.test(securityGate), 'security-gate muss preflight benötigen');
  invariant(
    /uses: \.\/\.forgejo\/workflows\/security\.yml/.test(securityGate),
    'security-gate ruft security.yml nicht auf',
  );
  invariant(
    /needs: \[preflight, full-ci, security-gate\]/.test(publish),
    'release muss preflight, full-ci und security-gate benötigen',
  );
  invariant(/needs: release/.test(manifest), 'manifest muss release benötigen');

  invariant(
    /verify-tag-checkout\.sh/.test(preflight) &&
      /verify-release-config\.mjs/.test(preflight) &&
      /verify-release-version\.mjs/.test(preflight),
    'preflight prüft Tag, Version oder Manifest-Konfiguration nicht',
  );
  invariant(
    /check-docker-bases-pinned\.mjs/.test(preflight),
    'preflight prüft die Digest-Pins der Docker-Basisimages nicht',
  );
  invariant(
    /UPDATE_MANIFEST_REPO/.test(preflight) &&
      /UPDATE_MANIFEST_TOKEN/.test(preflight) &&
      /UPDATE_MANIFEST_PRIVATE_KEY/.test(preflight),
    'preflight bindet nicht alle Manifest-Pflichtwerte ein',
  );
  invariant(/push --dry-run/.test(preflight), 'preflight prüft das Manifest-Schreibrecht nicht');
  invariant(
    /verify-update-manifest\.mjs/.test(preflight),
    'preflight verifiziert ein vorhandenes Manifest nicht mit dem Release-Key',
  );
  requireAskpass(preflight, 'preflight');

  invariant(/worker_digest:/.test(publish), 'release exportiert keinen Worker-Digest');
  const runtimeSmoke = publish.indexOf('smoke-release-images.sh');
  const trivyProvision = publish.indexOf('docker cp "$TRIVY_CONTAINER:/usr/local/bin/trivy"');
  const trivyScan = publish.indexOf('Trivy-Scan (CRITICAL mit Fix blockt den Push)');
  const sbomGeneration = publish.indexOf('--format cyclonedx');
  const sbomUpload = publish.indexOf('release-sbom-${{ steps.meta.outputs.version }}');
  const immutableCheck = publish.indexOf('docker manifest inspect');
  const firstDockerPush = publish.indexOf('docker push');
  const immutableGateStart = publish.lastIndexOf('if INSPECT_OUTPUT', immutableCheck);
  const immutableGate = publish.slice(immutableGateStart, firstDockerPush);
  invariant(
    runtimeSmoke >= 0 && runtimeSmoke < firstDockerPush,
    'finale Release-Images werden nicht vor dem Registry-Push als Stack getestet',
  );
  invariant(
    trivyProvision >= 0 &&
      trivyProvision < trivyScan &&
      (publish.match(/--docker-host "\$TRIVY_DOCKER_HOST"/g) ?? []).length >= 3 &&
      !/docker run --rm[\s\S]*?aquasec\/trivy/.test(publish.slice(trivyScan, sbomUpload)),
    'Trivy muss im Forgejo-Job nativ und gegen exakt denselben Docker-Daemon laufen',
  );
  invariant(
    sbomGeneration >= 0 &&
      sbomUpload > sbomGeneration &&
      sbomUpload < firstDockerPush &&
      /test -s "release-sbom\/\$\{img\}\.cdx\.json"/.test(publish),
    'Release erzeugt und archiviert keine CycloneDX-SBOMs vor dem Registry-Push',
  );
  invariant(
    immutableCheck >= 0 &&
      firstDockerPush >= 0 &&
      immutableGateStart >= 0 &&
      immutableCheck < firstDockerPush &&
      /INSPECT_OUTPUT="\$\(docker manifest inspect "\$ref"/.test(immutableGate) &&
      immutableGate.includes('[ "$INSPECT_OUTPUT" = "no such manifest: $ref" ]') &&
      immutableGate.includes('[ "$INSPECT_OUTPUT" = "manifest unknown" ]') &&
      /Registry-Status fuer \$ref ist nicht eindeutig/.test(immutableGate) &&
      (immutableGate.match(/exit 1/g) ?? []).length >= 2,
    'release schützt vorhandene SemVer-Image-Tags nicht fail-closed vor Überschreiben',
  );
  invariant(
    !/\/(?:web|worker):latest\b/.test(publish),
    'release darf keinen veraenderlichen latest-Tag publizieren',
  );
  for (const requiredArg of [
    '--commit-sha',
    '--web-image',
    '--web-image-digest',
    '--worker-image',
    '--worker-image-digest',
  ]) {
    invariant(manifest.includes(requiredArg), `Manifest-Aufruf ohne ${requiredArg}`);
  }
  requireAskpass(manifest, 'manifest');

  const dockerPushes = [...release.matchAll(/docker push/g)].map((match) => match.index);
  invariant(dockerPushes.length > 0, 'Registry-Push fehlt');
  const releaseStart = release.indexOf(publish);
  const releaseEnd = releaseStart + publish.length;
  invariant(
    dockerPushes.every((index) => index >= releaseStart && index < releaseEnd),
    'docker push liegt außerhalb des gegateten release-Jobs',
  );
  invariant(/\bgit push\b/.test(manifest), 'Manifest-Publikation fehlt');
  invariant(!/^\s+push:\s*true\s*$/m.test(release), 'build-push-action darf nicht direkt pushen');
  invariant(
    !/\b(?:skopeo|crane|oras)\s+(?:copy|push)\b/.test(release),
    'unbekannter Registry-Publish-Pfad',
  );

  return true;
}

function main() {
  try {
    checkReleaseGates({
      release: readFileSync('.forgejo/workflows/release.yml', 'utf8'),
      ci: readFileSync('.forgejo/workflows/ci.yml', 'utf8'),
      security: readFileSync('.forgejo/workflows/security.yml', 'utf8'),
      smoke: readFileSync('scripts/release/smoke-release-images.sh', 'utf8'),
      composeCi: readFileSync('infra/compose/docker-compose.ci.yml', 'utf8'),
    });
    process.stdout.write('Release-Gate-Struktur verifiziert.\n');
  } catch (error) {
    process.stderr.write(`RELEASE-GATE FEHLER: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
