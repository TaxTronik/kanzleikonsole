// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPostgresGosu } from '../ci/postgres-gosu-assessment.mjs';
import { packageFindings, serviceImageDecision } from '../ci/scan-service-images.mjs';

const digest = 'sha256:f3ee138d5fce80ffaeb315b8bea7610f0c4f2304fb2aceb4ec8e457b92fc41a0';
const image = `postgres:18-alpine3.23@${digest}`;
const otherDigest = 'sha256:' + 'a'.repeat(64);
const otherImage = image.replace(digest, otherDigest);
const binarySha256 = 'b1892636c281590f34bc63c1118f058cd9de66c4ea463772e3909672d8b302ac';

// Aus dem Trivy-Befund für das ausgelieferte linux/amd64-Image.
const finding = {
  VulnerabilityID: 'CVE-2025-68121',
  PkgName: 'stdlib',
  PkgID: 'stdlib@v1.24.6',
  InstalledVersion: 'v1.24.6',
  FixedVersion: '1.24.13, 1.25.7, 1.26.0-rc.3',
  Severity: 'CRITICAL',
};
const result = {
  Target: 'usr/local/bin/gosu',
  Class: 'lang-pkgs',
  Type: 'gobinary',
  Packages: [{ ID: 'stdlib@v1.24.6', Name: 'stdlib', Version: 'v1.24.6' }],
  Vulnerabilities: [finding],
};

function trivyReport(results = [result]) {
  return {
    SchemaVersion: 2,
    ArtifactName: image,
    ArtifactType: 'container_image',
    Metadata: {
      RepoDigests: [`postgres@${digest}`],
      ImageConfig: { os: 'linux', architecture: 'amd64' },
    },
    Results: results,
  };
}

function assess(results, overrides = {}) {
  return assessPostgresGosu({
    image,
    platform: 'linux/amd64',
    binarySha256,
    report: trivyReport(results),
    ...overrides,
  });
}

test('ordnet den nachgewiesenen Treffer genau der geprüften Binärdatei zu', () => {
  const decision = assess([result]);
  assert.equal(decision?.cve, finding.VulnerabilityID);
  assert.equal(decision.binarySha256, binarySha256);
  assert.equal(decision.status, 'not_affected');
});

test('behält beim Bewerten der geprüften CVE alle Scanbefunde im Rohbericht', () => {
  const other = {
    ...finding,
    VulnerabilityID: 'CVE-2025-61726',
    FixedVersion: '1.24.12, 1.25.6',
    Severity: 'HIGH',
  };
  const results = [{ ...result, Vulnerabilities: [other, finding] }];
  const original = globalThis.structuredClone(results);
  const decision = assess(results);
  assert.equal(decision?.cve, finding.VulnerabilityID);
  assert.deepEqual(results, original);
});

for (const [label, overrides] of [
  ['neuer Image-Digest', { image: otherImage }],
  ['andere Plattform', { platform: 'linux/arm64' }],
  ['andere Binärdatei', { binarySha256: 'a'.repeat(64) }],
  ['fehlender Binärnachweis', { binarySha256: undefined }],
]) {
  test(`keine Einzelfeststellung bei abweichendem Nachweis (${label})`, () => {
    assert.equal(assess([result], overrides), null);
  });
}

for (const [label, findings] of [
  ['andere CVE', [{ ...finding, VulnerabilityID: 'CVE-2025-61726' }]],
  ['anderes Paket', [{ ...finding, PkgName: 'github.com/tianon/gosu' }]],
  ['andere Go-Version', [{ ...finding, InstalledVersion: 'v1.24.7' }]],
  ['kein Treffer', []],
  ['doppelte Befundzeile', [finding, { ...finding }]],
]) {
  test(`keine Einzelfeststellung für abweichende oder mehrdeutige Befunde (${label})`, () => {
    assert.equal(assess([{ ...result, Vulnerabilities: findings }]), null);
  });
}

test('die gleiche CVE in einer anderen Binärdatei erhält keine Einzelfeststellung', () => {
  assert.equal(assess([{ ...result, Target: 'usr/local/bin/postgres' }]), null);
});

test('zwei passende Trivy-Ergebnisse für denselben Pfad sind mehrdeutig', () => {
  assert.equal(assess([result, { ...result }]), null);
});

for (const [label, fields] of [
  ['anderes Artefakt', { ArtifactName: otherImage }],
  ['anderer Artefakttyp', { ArtifactType: 'filesystem' }],
  [
    'anderer RepoDigest',
    { Metadata: { ...trivyReport().Metadata, RepoDigests: [`postgres@${otherDigest}`] } },
  ],
  [
    'andere Architektur',
    {
      Metadata: { ...trivyReport().Metadata, ImageConfig: { os: 'linux', architecture: 'arm64' } },
    },
  ],
]) {
  test(`abweichende Trivy-Metadaten halten den Befund blockierend (${label})`, () => {
    const report = { ...trivyReport(), ...fields };
    const counts = packageFindings(report);
    const decision = serviceImageDecision(image, report, counts, () => binarySha256);
    assert.equal(counts.criticalWithFix, 1);
    assert.equal(decision.blockingCriticalWithFix, 1);
    assert.deepEqual(decision.assessments, []);
  });
}

for (const [label, results] of [
  ['gleiche CVE in anderem Binary', [result, { ...result, Target: 'usr/local/bin/other' }]],
  [
    'andere CVE in gosu',
    [{ ...result, Vulnerabilities: [finding, { ...finding, VulnerabilityID: 'CVE-2025-61726' }] }],
  ],
]) {
  test(`bei zwei behebbaren CRITICAL bleibt der zweite Treffer blockierend (${label})`, () => {
    const report = trivyReport(results);
    const counts = packageFindings(report);
    const decision = serviceImageDecision(image, report, counts, () => binarySha256);
    assert.deepEqual(counts, { high: 0, critical: 2, criticalWithFix: 2 });
    assert.equal(decision.blockingCriticalWithFix, 1);
    assert.deepEqual(
      decision.assessments.map((entry) => entry.cve),
      [finding.VulnerabilityID],
    );
  });
}

test('der bewertete Einzeltreffer bleibt im Rohzähler und ergibt null blockierende Treffer', () => {
  const report = trivyReport();
  const counts = packageFindings(report);
  const decision = serviceImageDecision(image, report, counts, () => binarySha256);
  assert.deepEqual(counts, { high: 0, critical: 1, criticalWithFix: 1 });
  assert.equal(decision.blockingCriticalWithFix, 0);
  assert.equal(decision.assessments.length, 1);
});

test('ein abweichender Binärhash hält den rohen CRITICAL-Befund blockierend', () => {
  const report = trivyReport();
  const counts = packageFindings(report);
  const observed = 'a'.repeat(64);
  const decision = serviceImageDecision(image, report, counts, () => observed);
  assert.equal(counts.criticalWithFix, 1);
  assert.equal(decision.observedGosuSha256, observed);
  assert.equal(decision.blockingCriticalWithFix, 1);
  assert.deepEqual(decision.assessments, []);
});

test('bei einem Lesefehler bricht die Hashprüfung am vorgesehenen Image ab', () => {
  const report = trivyReport();
  const readHash = (ref) => {
    assert.equal(ref, image);
    throw new Error('Binärdatei unlesbar');
  };
  assert.throws(
    () => serviceImageDecision(image, report, packageFindings(report), readHash),
    /Binärdatei unlesbar/,
  );
});

test('ein neuer Digest zählt alle behebbaren CRITICAL ohne Zugriff auf gosu', () => {
  const report = trivyReport();
  const counts = packageFindings(report);
  const decision = serviceImageDecision(otherImage, report, counts, () =>
    assert.fail('Unzulässige Hashprobe'),
  );
  assert.equal(counts.criticalWithFix, 1);
  assert.equal(decision.blockingCriticalWithFix, 1);
  assert.deepEqual(decision.assessments, []);
});
