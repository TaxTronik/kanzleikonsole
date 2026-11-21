// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import { applyAdvisories, nvdUrl } from '../ci/clamav-advisories.mjs';
import {
  checkEngine as inspectEngine,
  packageFindings,
  serviceInventory,
} from '../ci/scan-service-images.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const clamav = { image: `clamav/clamav:1.5.5@${digest}` };
const feed = ['1.5.2', '1.5.5', '1.4.7'].map((version) => ({
  tag_name: 'clamav-' + version,
  draft: false,
  prerelease: false,
  body: 'Fixes CVE-2026-76417.',
}));
const matrix = [
  '| Feature release | First Published | Latest patch version | Patch versions continue until |',
  '| 1.5 | Oct-7 2025 | 1.5.5 | 1.6 + 4 months, or 1.7 |',
  '| **1.4  LTS** | **Aug-15 2024** | **1.4.7** | **Aug-15 2027**  (3 years) |',
  '| 1.3 | Feb-7 2024 | 1.3.2 | Dec-15 2024 (1.4 + 4 months, or 1.5) |',
].join('\n');
const checkEngine = (image, version, notes, support = matrix, time = '2026-11-21') =>
  inspectEngine(image, version, notes, support, Date.parse(time));

test('Inventar erfasst neue Fremdimages, dedupliziert und erkennt fremde dynamische oder ungepinnte Ziele', () => {
  const postgres = { image: 'postgres:18-alpine@sha256:' + 'b'.repeat(64) };
  const { images } = serviceInventory({ clamav, postgres, 'tcms-db': postgres });
  assert.equal(images.length, 2);
  assert.deepEqual(images[1].services, ['postgres', 'tcms-db']);
  for (const image of ['external/tool:latest', '${FOREIGN_IMAGE}', undefined]) {
    assert.throws(() => serviceInventory({ clamav, cron: { image } }), /Digest fehlt bei cron/);
  }
  assert.throws(
    () => serviceInventory({ clamav: { image: 'other/clamav:1.5.5@' + digest } }),
    /offiziellen Versions-Tag/,
  );
  assert.throws(() => serviceInventory({ postgres }), /ClamAV/);
});

test('ein optionales Overlay verdrängt das im Standardbetrieb eingesetzte Image nicht aus dem Inventar', () => {
  const first = { image: 'postgres:18-alpine@sha256:' + 'b'.repeat(64) };
  const other = { image: 'postgres:18-alpine@sha256:' + 'c'.repeat(64) };
  const base = { clamav, postgres: first };
  const overlay = { clamav, postgres: other, 'tcms-db': first };
  const { images } = serviceInventory(base, overlay, overlay);
  assert.deepEqual(
    images.map(({ image, services }) => [image, services]),
    [
      [clamav.image, ['clamav']],
      [first.image, ['postgres', 'tcms-db']],
      [other.image, ['postgres']],
    ],
  );
  assert.throws(
    () =>
      serviceInventory(base, {
        ...overlay,
        clamav: { image: clamav.image.replace('1.5.5', '1.5.2') },
      }),
    /Abweichender ClamAV-Pin/,
  );
});

test('Compose, Smoke-Basis und E2E verwenden denselben ClamAV-Pin', () => {
  const refs = [
    'infra/compose/docker-compose.yml',
    'infra/compose/docker-compose.ci.yml',
    '.forgejo/workflows/ci.yml',
  ].map(
    (file) =>
      readFileSync(file, 'utf8').match(
        /^\s*(?:image:\s*|FROM\s+)(clamav\/clamav:\d+\.\d+\.\d+@sha256:[0-9a-f]{64})\s*$/m,
      )?.[1],
  );
  assert.ok(refs[0]);
  assert.deepEqual(refs, [refs[0], refs[0], refs[0]]);
});

test('Postgres, Redis, SeaweedFS und n8n laufen in den zugehörigen Prüf- und Betriebsprofilen mit identischem Digest', () => {
  const compose = 'infra/compose/docker-compose';
  const ci = '.forgejo/workflows/ci.yml';
  const sources = {
    'postgres:18-alpine': [compose + '.yml', compose + '.tcms.yml', compose + '.ci.yml', ci],
    'redis:7-alpine': [compose + '.yml', ci],
    'chrislusf/seaweedfs:': [compose + '.yml', compose + '.ci.yml', ci],
    'n8nio/n8n:': [compose + '.app.yml', compose + '.dev.yml', compose + '.ci.yml'],
  };
  for (const [image, files] of Object.entries(sources)) {
    const pins = files.map((file) => {
      // Compose image, Dockerfile FROM und eigenständiges Imageargument von docker create.
      const refs = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) =>
          line
            .trim()
            .replace(/^(?:image:\s+|FROM\s+)/, '')
            .replace(/\s+\\$/, ''),
        )
        .filter((line) => line.startsWith(image));
      assert.equal(refs.length, 1, image + ' in ' + file);
      assert.match(refs[0], /^[^\s@]+@sha256:[0-9a-f]{64}$/);
      return refs[0];
    });
    assert.equal(new Set(pins).size, 1, image + ': ' + pins.join(', '));
  }
});

test('AWS-CLI nutzt denselben Digest für Betrieb, Init, E2E und Wiederherstellung', () => {
  const expected = new Map([
    ['infra/compose/docker-compose.yml', 1],
    ['infra/compose/docker-compose.ci.yml', 1],
    ['.forgejo/workflows/ci.yml', 2],
    ['scripts/ops-lib.sh', 1],
    ['.env.example', 1],
    ['docs/operations/disaster-recovery.md', 1],
  ]);
  const pins = new Set();
  for (const [file, count] of expected) {
    const refs = readFileSync(file, 'utf8').match(/amazon\/aws-cli:[^\s"'\\]+/g) ?? [];
    assert.equal(refs.length, count, file);
    for (const ref of refs) {
      assert.match(ref, /^amazon\/aws-cli:[\w.-]+@sha256:[0-9a-f]{64}$/, file);
      pins.add(ref);
    }
  }
  assert.equal(pins.size, 1, [...pins].join(', '));
});

test('Engine-Gate vergleicht den Binary-Stand innerhalb seiner Herstellerlinie numerisch', () => {
  assert.equal(checkEngine(clamav.image, 'ClamAV 1.5.5/28188', feed).status, 'passed');
  const old = checkEngine(clamav.image.replace('1.5.5', '1.5.2'), 'ClamAV 1.5.2/28017', feed);
  assert.equal(old.status, 'update-required');
  assert.deepEqual(
    old.newer.map(({ version, cves }) => [version, cves]),
    [['1.5.5', ['CVE-2026-76417']]],
  );
  const withUpdates = [
    ...feed,
    { ...feed[0], tag_name: 'clamav-1.5.10', body: 'Maintenance release' },
  ];
  assert.equal(checkEngine(clamav.image, 'ClamAV 1.5.5', withUpdates).newer[0].version, '1.5.10');
  const beta = { ...withUpdates.at(-1), prerelease: true };
  assert.equal(checkEngine(clamav.image, 'ClamAV 1.5.5', [...feed, beta]).status, 'passed');
});

test('fehlender Herstellerbeleg, unlesbarer Releasehinweis und falsches Binary brechen die Engineprüfung ab', () => {
  assert.throws(() => checkEngine(clamav.image, 'ClamAV 1.5.2', feed), /Binärversion/);
  assert.throws(() => checkEngine(clamav.image, 'ClamAV 1.5.5', []), /Herstellerbestätigung/);
  assert.throws(
    () => checkEngine(clamav.image, 'ClamAV 1.5.5', [...feed, { ...feed[0], body: '' }]),
    /Herstellerhinweis/,
  );
});

test('kritischer Patchsupport folgt der Herstellerfrist der jeweiligen Linie, einschließlich älterer LTS', () => {
  const check = (v, notes, support, time) =>
    checkEngine(clamav.image.replace('1.5.5', v), 'ClamAV ' + v, notes, support, time);
  const release = (v, date) => ({ ...feed[0], tag_name: 'clamav-' + v, published_at: date });
  const notes = [...feed, release('1.3.2', '2025-01-03'), release('1.6.0', '2026-10-31T12:15:00Z')];
  assert.equal(check('1.3.2', notes).status, 'update-required');
  assert.equal(check('1.4.7', notes).status, 'passed');
  assert.equal(check('1.4.7', notes, matrix, '2027-08-15').status, 'update-required');
  assert.equal(check('1.5.5', notes, matrix, '2027-02-27').status, 'passed');
  assert.equal(check('1.5.5', notes, matrix, '2027-02-28').status, 'update-required');
  assert.equal(
    check('1.5.5', [...notes, release('1.7.0', '2026-11-01')]).status,
    'update-required',
  );
  assert.equal(
    check('1.5.5', [...feed, { ...notes.at(-1), prerelease: true }], matrix, '2028-01-01').status,
    'passed',
  );
  assert.equal(
    check('1.5.5', feed, matrix.replace('| 1.5.5 |', '| 1.5.6 |')).status,
    'update-required',
  );
  assert.throws(
    () => check('1.5.5', feed, matrix.replace('1.6 + 4 months, or 1.7', 'pending')),
    /Unbekannte/,
  );
  assert.throws(() => check('1.5.5', feed, ''), /Supportmatrix/);
  assert.throws(
    () => check('1.5.5', [...feed, release('1.6.1', '2026-11-01')]),
    /Veröffentlichungsdatum/,
  );
});

test('exakte CPE sperrt betroffene Engine auch bei aktuellem Patch und einer Meldung in einer anderen Linie', () => {
  const engine = { actual: '1.4.7', status: 'passed' };
  const source = (v, date, body) => ({
    ...feed[0],
    tag_name: 'clamav-' + v,
    published_at: date,
    body,
  });
  const notices = [
    source('1.4.0', '2024-08-15', 'Feature release'),
    source('1.4.7', '2026-11-18', 'Maintenance'),
    source('1.5.3', '2026-08-01', 'CVE-2099-1111 and CVE-2099-1112'),
  ];
  const match = {
    vulnerable: true,
    criteria: 'cpe:2.3:a:clamav:clamav:*:*:*:*:*:*:*:*',
    versionStartIncluding: '1.4.7',
    versionEndExcluding: '1.4.8',
  };
  const other = {
    vulnerable: true,
    criteria: 'cpe:2.3:a:cisco:web_security_appliance:9.1.0-070:*:*:*:*:*:*:*',
  };
  const node = (...criteria) => ({ operator: 'OR', cpeMatch: criteria });
  const rec = (id, config) => ({ cve: { id, configurations: [config] } });
  const records = [
    rec('CVE-2099-1111', { nodes: [node(match)] }),
    rec('CVE-2016-1405', { operator: 'AND', nodes: [node(match), node(other)] }),
  ];
  const response = {
    version: '2.0',
    startIndex: 0,
    totalResults: 2,
    timestamp: '2026-11-21T12:00:00Z',
    vulnerabilities: records,
  };
  const verdict = applyAdvisories(engine, notices, response);
  assert.equal(verdict.status, 'vulnerable');
  assert.deepEqual(
    verdict.nvd.affected.map(({ cve }) => cve),
    ['CVE-2099-1111'],
  );
  assert.deepEqual(
    verdict.nvd.conditional.map(({ cve }) => cve),
    ['CVE-2016-1405'],
  );
  assert.deepEqual(verdict.crossLineReview, [{ tag: 'clamav-1.5.3', cves: ['CVE-2099-1112'] }]);
  assert.equal(
    new URL(nvdUrl(engine.actual)).searchParams.get('cpeName'),
    'cpe:2.3:a:clamav:clamav:1.4.7:*:*:*:*:*:*:*',
  );
  assert.ok(new URL(nvdUrl(engine.actual)).searchParams.has('isVulnerable'));
  const latest = { ...engine, actual: '1.4.8' };
  assert.equal(applyAdvisories(latest, notices, response).status, 'passed');
  const handled = [...notices, source('1.4.8', '2026-11-21', 'CVE-2099-1112')];
  assert.deepEqual(applyAdvisories(engine, handled, response).crossLineReview, []);
  assert.throws(
    () => applyAdvisories(engine, notices, { ...response, totalResults: 3 }),
    /Unvollständige NVD-Antwort/,
  );
  assert.throws(
    () =>
      applyAdvisories(engine, notices, {
        ...response,
        vulnerabilities: [{ cve: { id: 'CVE-2099-1111' } }, records[1]],
      }),
    /NVD-Treffer/,
  );
});

test('Gate unterscheidet CRITICAL mit Fix, ungefixte Befunde und fehlende Paketabdeckung', () => {
  const report = {
    SchemaVersion: 2,
    Results: [
      {
        Packages: [{ Name: 'libxml2' }],
        Vulnerabilities: [
          { Severity: 'HIGH', FixedVersion: '2' },
          { Severity: 'CRITICAL' },
          { Severity: 'CRITICAL', FixedVersion: '2' },
        ],
      },
    ],
  };
  assert.deepEqual(packageFindings(report), { high: 1, critical: 2, criticalWithFix: 1 });
  assert.deepEqual(packageFindings({ SchemaVersion: 2, Results: [{ Packages: [{}] }] }), {
    high: 0,
    critical: 0,
    criticalWithFix: 0,
  });
  assert.throws(() => packageFindings({ SchemaVersion: 2, Results: [] }), /Paketinventar/);
});

test('der geplante Bot-Lauf erreicht die tägliche ClamAV-Regel und das normale Montagsfenster', () => {
  const config = JSON.parse(readFileSync('renovate.json', 'utf8'));
  const workflow = readFileSync('.forgejo/workflows/renovate.yml', 'utf8');
  assert.match(workflow, /cron: '23 3 \* \* \*'/);
  assert.deepEqual(config.schedule, ['before 7am on monday']);
  const general = config.packageRules.findIndex((rule) => rule.groupName === 'Container-Images');
  const separate = config.packageRules.find(
    (rule) => rule.matchPackageNames?.includes('clamav/clamav') && rule.separateMinorPatch,
  );
  assert.deepEqual(separate?.matchDatasources, ['docker']);
  assert.equal(separate.matchUpdateTypes, undefined);
  const special = config.packageRules.findIndex((rule) => rule.groupName === 'ClamAV');
  assert.ok(general >= 0 && special > general);
  const rule = config.packageRules[special];
  assert.deepEqual(rule.matchPackageNames, ['clamav/clamav']);
  assert.deepEqual(rule.matchUpdateTypes, ['patch', 'digest']);
  assert.deepEqual(rule.schedule, ['at any time']);
  assert.deepEqual(rule.matchDatasources, ['docker']);
  assert.equal(rule.groupName, 'ClamAV');
  assert.ok(rule.prPriority > 0);
});

test('ein fehlender Docker-Zugang liefert einen technischen Fehler und einen Nachweis', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'service-image-security-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  const run = spawnSync(process.execPath, ['scripts/ci/scan-service-images.mjs', dir], {
    env: { ...env, PATH: dir },
    encoding: 'utf8',
  });
  assert.equal(run.status, 2, run.stderr);
  const report = JSON.parse(readFileSync(join(dir, 'scan-error.json'), 'utf8'));
  assert.equal(report.status, 'error');
  assert.match(report.error, /docker/i);
});
