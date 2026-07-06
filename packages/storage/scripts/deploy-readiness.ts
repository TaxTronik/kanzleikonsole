// =============================================================================
// pnpm verify:deploy  (Root: pnpm verify:deploy-readiness)
//
// Prod-Konfigurations-Gate NACH dem Deploy: prüft, dass die deployte
// Infrastruktur nicht nur erreichbar, sondern korrekt KONFIGURIERT ist
// (S3-Buckets + Object-Lock, ClamAV-Größe + Signaturen, Storage-Roundtrip).
// Läuft auf dem Host gegen die veröffentlichten Ports (S3_ENDPOINT/CLAMAV_HOST
// aus der .env) — komplementär zu `/api/health` (das die interne Erreichbarkeit
// aus dem Container prüft). Exit 1 bei einem harten Fehler, 2 bei Lauf-Fehler.
//
// In CI läuft derselbe Check gegen die echte docker-compose.app.yml-Topologie
// (Job `deploy-readiness`) und fängt so Prod-Konfig-Regressionen VOR dem Kunden.
// =============================================================================

import { checkDeployReadiness } from '../src/deploy-readiness';

const ICON: Record<string, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };

async function main() {
  // Optionaler schnellerer Größen-Scan via ENV (CI/lokal), Default = 100 MB.
  const overrideMib = process.env['DEPLOY_READINESS_CLAMAV_MIB'];
  const clamavScanBytes = overrideMib
    ? Math.max(1, Number(overrideMib)) * 1024 * 1024
    : undefined;

  process.stdout.write('[verify:deploy] Prüfe Prod-Konfiguration (S3/Object-Lock/ClamAV/Roundtrip)…\n');
  const report = await checkDeployReadiness({ clamavScanBytes });

  for (const c of report.checks) {
    process.stdout.write(
      `  ${ICON[c.status] ?? '  '} ${c.name}: ${c.detail} (${c.durationMs} ms)\n`,
    );
  }

  const fails = report.checks.filter((c) => c.status === 'fail');
  const warns = report.checks.filter((c) => c.status === 'warn');

  if (report.ok) {
    process.stdout.write(
      `[verify:deploy] ✅ Deploy-Readiness OK — ${report.checks.length} Prüfungen` +
        (warns.length ? `, ${warns.length} Warnung(en)` : '') +
        '.\n',
    );
    process.exit(0);
  }

  process.stderr.write(
    `\n[verify:deploy] ❌ ${fails.length} Prüfung(en) fehlgeschlagen — Deployment ist nicht bereit:\n`,
  );
  for (const f of fails) process.stderr.write(`  ❌ ${f.name}: ${f.detail}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[verify:deploy] Unerwarteter Fehler: ${(err as Error).message}\n`);
  process.exit(2);
});
