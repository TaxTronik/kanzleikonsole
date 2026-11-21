// Security-Workflow. Inventar und Befunde beziehen sich auf dieselben
// unveränderlichen Linux-amd64-Manifeste wie die produktive Compose-Konfiguration.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyAdvisories, nvdUrl } from './clamav-advisories.mjs';
import {
  assessPostgresGosu,
  gosuPath,
  reviewedPostgresImage,
} from './postgres-gosu-assessment.mjs';

const platform = 'linux/amd64';
const releasesUrl = 'https://api.github.com/repos/Cisco-Talos/clamav/releases?per_page=100';
const supportUrl =
  'https://raw.githubusercontent.com/Cisco-Talos/clamav-documentation/main/src/faq/faq-eol.md';
const pinnedImage = /^[a-z0-9][a-z0-9./:_-]*:[\w.-]+@sha256:[0-9a-f]{64}$/;
const clamavTag = /^clamav\/clamav:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/;

// Eigene Release-Images und optionale, vom Betreiber gewählte Komponenten
// haben vor dem Deployment keinen festen Drittanbieter-Digest im Compose.
const configuredImages = {
  app: '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/web:',
  worker: '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/worker:',
  migrate: '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/worker:',
  'backup-dir-init': '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/worker:',
  'tcms-api': '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/tcms-api:',
  'tcms-migrate': '${TAXTRONIK_IMAGE_PREFIX:-taxtronik}/tcms-migrate:',
  'risk-layer': '${SIGNAL_IMAGE:-',
  'eric-bridge': '${ERIC_BRIDGE_IMAGE:-',
};

export function serviceInventory(...models) {
  const images = new Map();
  const clamav = models[0]?.clamav?.image;
  if (!clamavTag.test(clamav))
    throw new Error('ClamAV braucht den offiziellen Versions-Tag und Digest');
  for (const services of models) {
    if (services.clamav?.image !== clamav)
      throw new Error('Abweichender ClamAV-Pin im Compose-Overlay');
    for (const [service, { image }] of Object.entries(services)) {
      if (configuredImages[service] && image?.startsWith(configuredImages[service])) continue;
      if (!pinnedImage.test(image)) throw new Error(`Fester Image-Digest fehlt bei ${service}`);
      const digest = image.split('@')[1];
      if (!images.has(digest)) images.set(digest, { image, digest, services: [] });
      const names = images.get(digest).services;
      if (!names.includes(service)) names.push(service);
    }
  }
  return { images: [...images.values()], clamav };
}

export function productionInventory() {
  const proxy = 'docker-compose.traefik.yml';
  const tcms = 'docker-compose.tcms.yml';
  // Ein Overlay kann ein Standardimage ersetzen. Beide Varianten zählen.
  const models = [[], [proxy], [tcms], [proxy, tcms]].map((overlays) => {
    const files = ['docker-compose.yml', 'docker-compose.app.yml', ...overlays];
    const args = [
      'compose',
      ...files.flatMap((file) => ['-f', `infra/compose/${file}`]),
      '--profile',
      '*',
      'config',
      '--no-interpolate',
      '--no-env-resolution',
      '--format',
      'json',
    ];
    return JSON.parse(execFileSync('docker', args, { encoding: 'utf8' })).services;
  });
  return serviceInventory(...models);
}

function policyDate(text) {
  const date = /^([A-Z][a-z]{2})-(\d{1,2}) (\d{4})(?:$| \()/.exec(text);
  if (!date) return null;
  const day = Date.parse(`${date[1]} ${date[2]} ${date[3]} 00:00:00 GMT`);
  if (!Number.isFinite(day)) throw new Error(`Ungültiges Herstellerdatum: ${text}`);
  return day;
}

function patchSupport(major, minor, releases, markdown, today) {
  const rows = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.replaceAll('**', '').trim().replace(/\s+/g, ' ')),
    );
  const header = rows.find(([name]) => name === 'Feature release') ?? [];
  const rowFor = (series) => rows.find(([name]) => name === series || name === series + ' LTS');
  const series = `${major}.${minor}`;
  const row = rowFor(series);
  const limit = row?.[header.indexOf('Patch versions continue until')];
  const latest = row?.[header.indexOf('Latest patch version')];
  if (!limit || !latest?.startsWith(series + '.') || !/^\d+\.\d+\.\d+$/.test(latest)) {
    throw new Error(`Unvollständige ClamAV-Patch-Supportmatrix für ${series}`);
  }

  function featureDate(feature) {
    const [maj, min] = feature.split('.').map(Number);
    const documented = policyDate(rowFor(feature)?.[header.indexOf('First Published')]);
    if (documented !== null) return documented;
    const first = releases.find((r) => r.tag_name === `clamav-${feature}.0`);
    if (first && Number.isFinite(Date.parse(first.published_at)))
      return Date.parse(first.published_at);
    if (
      releases.some((r) => {
        const version = /^clamav-(\d+)\.(\d+)\.\d+$/.exec(r.tag_name);
        return version && (+version[1] > maj || (+version[1] === maj && +version[2] >= min));
      })
    )
      throw new Error(`Veröffentlichungsdatum der ClamAV-Linie ${feature} fehlt`);
    return null;
  }

  let until = policyDate(limit);
  if (until === null) {
    const relative = /^(\d+\.\d+) \+ (\d+) months?, or (\d+\.\d+)$/.exec(limit);
    if (!relative) throw new Error(`Unbekannte ClamAV-Patchfrist: ${limit}`);
    const next = featureDate(relative[1]);
    const following = featureDate(relative[3]);
    if (next !== null) {
      const start = new Date(next);
      const month = start.getUTCMonth() + Number(relative[2]);
      const year = start.getUTCFullYear();
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      until = Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay));
    }
    if (following !== null) until = Math.min(until ?? Infinity, following);
  }
  return {
    source: supportUrl,
    latest,
    limit,
    until: until === null ? null : new Date(until).toISOString(),
    expired: until !== null && today >= until,
  };
}

export function checkEngine(image, versionOutput, feed, supportMatrix, today = Date.now()) {
  const tag = clamavTag.exec(image)?.[1];
  const actual = /^ClamAV (\d+\.\d+\.\d+)(?:\/|\s|$)/m.exec(versionOutput)?.[1];
  if (!tag || actual !== tag)
    throw new Error('ClamAV-Binärversion und gepinnter Image-Tag stimmen nicht überein');

  const [major, minor, patch] = actual.split('.').map(Number);
  const releases = feed.filter(
    (release) => release.draft === false && release.prerelease === false,
  );
  const sameSeries = releases.flatMap((release) => {
    const version = /^clamav-(\d+)\.(\d+)\.(\d+)$/.exec(release.tag_name);
    if (!version || Number(version[1]) !== major || Number(version[2]) !== minor) return [];
    if (typeof release.body !== 'string' || !release.body.trim())
      throw new Error(`Fehlender Herstellerhinweis für ${release.tag_name}`);
    return [
      {
        version: version[0].slice(7),
        patch: Number(version[3]),
        cves: [...new Set(release.body.match(/\bCVE-\d{4}-\d{4,}\b/g) ?? [])].sort(),
      },
    ];
  });
  if (!sameSeries.some((release) => release.patch === patch)) {
    throw new Error(`Keine veröffentlichte Herstellerbestätigung für die Engine ${actual}`);
  }
  // Auch eine neue Wartungsversion ohne explizite CVE-Kennung verlangt die
  // Aktualisierung. Die Freitextformulierung des Advisories entscheidet nicht.
  const newer = sameSeries
    .filter((release) => release.patch > patch)
    .sort((a, b) => a.patch - b.patch);
  const support = patchSupport(major, minor, releases, supportMatrix, today);
  return {
    image,
    platform,
    actual,
    source: releasesUrl,
    support,
    newer,
    status:
      newer.length || support.expired || Number(support.latest.split('.')[2]) > patch
        ? 'update-required'
        : 'passed',
  };
}

export function packageFindings(report) {
  if (report.SchemaVersion !== 2 || !report.Results?.some((target) => target.Packages?.length)) {
    throw new Error('Trivy hat kein auswertbares Paketinventar geliefert');
  }
  const vulnerabilities = report.Results.flatMap((target) => target.Vulnerabilities ?? []);
  const critical = vulnerabilities.filter((v) => v.Severity === 'CRITICAL');
  return {
    high: vulnerabilities.filter((v) => v.Severity === 'HIGH').length,
    critical: critical.length,
    criticalWithFix: critical.filter((v) => v.FixedVersion).length,
  };
}

function save(directory, name, value) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n');
}

function runImageCommand(image, entrypoint, args) {
  return execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      platform,
      '--network',
      'none',
      '--read-only',
      '--user',
      '65534:65534',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '32',
      '--memory',
      '128m',
      '--entrypoint',
      entrypoint,
      image,
      ...args,
    ],
    { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );
}

function readGosuHash(image) {
  return createHash('sha256')
    .update(runImageCommand(image, '/bin/cat', [gosuPath]))
    .digest('hex');
}

export function serviceImageDecision(image, report, counts, readHash = readGosuHash) {
  const checkGosu = image === reviewedPostgresImage && counts.criticalWithFix > 0;
  const binarySha256 = checkGosu ? readHash(image) : undefined;
  const assessment = checkGosu
    ? assessPostgresGosu({ image, platform, report, binarySha256 })
    : null;
  const assessments = assessment ? [assessment] : [];
  return {
    blockingCriticalWithFix: counts.criticalWithFix - assessments.length,
    assessments,
    ...(checkGosu ? { observedGosuSha256: binarySha256 } : {}),
  };
}

function runScan(directory) {
  mkdirSync(directory, { recursive: true });
  const inventory = productionInventory();
  save(directory, 'images.json', { platform, ...inventory });
  const summaries = [];
  // 0 bestanden, 1 fachlicher Befund, 2 technisch unvollständiger Scan.
  let exitCode = 0;
  try {
    const version = runImageCommand(inventory.clamav, '/usr/bin/clamscan', ['--version']).toString(
      'utf8',
    );
    const readSource = (url) =>
      execFileSync(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--retry',
          '3',
          '--max-time',
          '30',
          '--user-agent',
          'TaxTronik-service-image-CI',
          url,
        ],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      );
    const feed = JSON.parse(readSource(releasesUrl));
    const versionCheck = checkEngine(inventory.clamav, version, feed, readSource(supportUrl));
    const engine = applyAdvisories(
      versionCheck,
      feed,
      JSON.parse(readSource(nvdUrl(versionCheck.actual))),
    );
    save(directory, 'clamav-engine.json', engine);
    console.log(`ClamAV ${engine.actual}: ${engine.status}`);
    if (engine.nvd.conditional.length || engine.crossLineReview.length) {
      console.log(
        'ClamAV-Hinweise zur Nachprüfung:',
        JSON.stringify({
          conditional: engine.nvd.conditional.map((c) => c.cve),
          crossLineReview: engine.crossLineReview,
        }),
      );
    }
    if (engine.status !== 'passed') {
      exitCode = 1;
      console.error(
        'ClamAV-Patchstand oder -Support:',
        JSON.stringify({
          newer: engine.newer,
          support: engine.support,
          affected: engine.nvd.affected.map(({ cve }) => cve),
        }),
      );
    }
  } catch (error) {
    save(directory, 'clamav-engine.json', {
      image: inventory.clamav,
      status: 'error',
      error: error.message,
    });
    console.error('Engine-Prüfung fehlgeschlagen:', error.message);
    exitCode = 2;
  }

  const scanner = process.env.TRIVY_BIN;
  if (!scanner || !process.env.RUNNER_TEMP) throw new Error('TRIVY_BIN oder RUNNER_TEMP fehlt');
  const cache = join(process.env.RUNNER_TEMP, 'service-image-trivy-cache');
  const runTrivy = (args) => execFileSync(scanner, args, { stdio: 'inherit' });
  runTrivy(['image', '--cache-dir', cache, '--download-db-only', '--no-progress']);
  const database = JSON.parse(readFileSync(join(cache, 'db', 'metadata.json'), 'utf8'));
  if (!Number.isFinite(Date.parse(database.UpdatedAt))) throw new Error('Trivy-DB ohne Datenstand');
  save(directory, 'trivy-db.json', database);
  for (const { image, digest, services } of inventory.images) {
    const file = digest.slice('sha256:'.length) + '.json';
    const summary = { image, services, platform };
    try {
      runTrivy([
        'image',
        '--cache-dir',
        cache,
        '--skip-db-update',
        '--platform',
        platform,
        '--image-src',
        'remote',
        '--scanners',
        'vuln',
        '--list-all-pkgs',
        '--severity',
        'HIGH,CRITICAL',
        '--timeout',
        '10m',
        '--no-progress',
        '--format',
        'json',
        '--output',
        join(directory, file),
        image,
      ]);
      const report = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      const counts = packageFindings(report);
      Object.assign(summary, { file, ...counts });
      const decision = serviceImageDecision(image, report, counts);
      const status = decision.blockingCriticalWithFix ? 'fix-required' : 'passed';
      summaries.push({ ...summary, status, ...decision });
      console.log(
        `${image} HIGH=${counts.high} CRITICAL=${counts.critical} CRITICAL mit Fix=${counts.criticalWithFix} blockierend=${decision.blockingCriticalWithFix}`,
      );
      for (const assessment of decision.assessments)
        console.log(assessment.cve, assessment.status, assessment.binarySha256);
      if (decision.blockingCriticalWithFix) exitCode = Math.max(exitCode, 1);
    } catch (error) {
      summaries.push({ ...summary, status: 'error', error: error.message });
      console.error(`${image}: Scannen fehlgeschlagen: ${error.message}`);
      exitCode = 2;
    }
  }
  save(directory, 'scan-summary.json', summaries);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runScan(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    if (process.argv[2]) {
      try {
        save(process.argv[2], 'scan-error.json', { status: 'error', error: error.message });
      } catch (writeError) {
        console.error('Fehlerbericht konnte nicht gespeichert werden:', writeError.message);
      }
    }
  }
}
