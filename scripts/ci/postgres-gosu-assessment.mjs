// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
// Diese Identitäten gehören zum geprüften Befund. Ein neuer Compose-Pin
// benötigt eine neue Binärprüfung und eine eigene Freigabeentscheidung.
const digest = 'sha256:f3ee138d5fce80ffaeb315b8bea7610f0c4f2304fb2aceb4ec8e457b92fc41a0';
export const reviewedPostgresImage = `postgres:18-alpine3.23@${digest}`;
export const gosuPath = '/usr/local/bin/gosu';
const reviewedHash = 'b1892636c281590f34bc63c1118f058cd9de66c4ea463772e3909672d8b302ac';
const cve = 'CVE-2025-68121';

export function assessPostgresGosu({ image, platform, report, binarySha256 }) {
  const config = report.Metadata?.ImageConfig;
  if (
    image !== reviewedPostgresImage ||
    platform !== 'linux/amd64' ||
    binarySha256 !== reviewedHash ||
    report.SchemaVersion !== 2 ||
    report.ArtifactType !== 'container_image' ||
    report.ArtifactName !== image ||
    !report.Metadata?.RepoDigests?.includes(`postgres@${digest}`) ||
    config?.os !== 'linux' ||
    config?.architecture !== 'amd64'
  )
    return null;

  const findings = report.Results.filter(
    (r) => r.Class === 'lang-pkgs' && r.Type === 'gobinary' && r.Target === gosuPath.slice(1),
  )
    .flatMap((r) => r.Vulnerabilities ?? [])
    .filter(
      (v) =>
        v.VulnerabilityID === cve &&
        v.PkgName === 'stdlib' &&
        v.PkgID === 'stdlib@v1.24.6' &&
        v.InstalledVersion === 'v1.24.6' &&
        v.Severity === 'CRITICAL' &&
        v.FixedVersion,
    );
  if (findings.length !== 1) return null;
  return {
    cve,
    status: 'not_affected',
    justification: 'vulnerable_code_not_present',
    target: gosuPath,
    binarySha256,
    advisory: 'https://pkg.go.dev/vuln/GO-2026-4337',
    evidence:
      'docs/reviews/2026-11-21-nachpruefung-imagepflege-und-codeabbau.md#nachtrag-zur-gosu-sicherheitsrichtlinie-am-21-november',
  };
}
