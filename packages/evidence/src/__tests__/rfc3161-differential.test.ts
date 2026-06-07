// =============================================================================
// Differenz-Test: unsere pkijs-verify() gegen `openssl ts -verify`.
//
// Logik wie rerank-vs-oracle: eine UNABHÄNGIGE Referenz, gegen die sich die
// eigene Implementierung beweisen muss, statt sich selbst zu attestieren. Für
// jedes Fixture müssen beide zum SELBEN Urteil kommen — wo nicht, ist es ein
// Befund.
//
// EINE dokumentierte, GEWOLLTE Abweichung: `openssl ts -verify` prüft die Cert-
// Gültigkeit gegen die SYSTEMUHR; wir prüfen gegen die genTime im Token (RFC-3161-
// korrekt für Langzeit-Evidenz — ein 2020er Seal bleibt gültig, auch wenn das
// TSA-Cert heute abgelaufen ist). Diese Abweichung wird unten EXPLIZIT geprüft.
//
// Übersprungen, wenn openssl nicht im PATH ist (CI ohne openssl bricht nicht).
//
// Horizont: `openssl ts -verify` prüft gegen die Systemuhr — die „beide OK"-Fälle
// gelten, solange die Signer-Certs wanduhr-gültig sind (GlobalSign-Leaf bis
// 2037, Mini-CA-Leaf bis 2035). Danach Fixtures via scripts/gen-tsa-fixtures.ts
// neu erzeugen. Unsere pkijs-verify() ist davon unberührt (prüft gegen genTime).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyTimestampResponse } from '../ports/rfc3161-verify';

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, 'fixtures');
const fp = (n: string) => join(fxDir, n);

function hasOpenssl(): boolean {
  try {
    const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** true = „Verification: OK", false = FAILED/Fehler. */
function opensslVerify(dataFile: string, tsrFile: string, caFile: string): boolean {
  const r = spawnSync(
    'openssl',
    ['ts', '-verify', '-data', dataFile, '-in', tsrFile, '-CAfile', caFile],
    { encoding: 'utf8' },
  );
  return /Verification:\s*OK/.test((r.stdout ?? '') + (r.stderr ?? ''));
}

async function pkijsValid(dataFile: string, tsrFile: string, caFile: string): Promise<boolean> {
  const payload = new Uint8Array(readFileSync(dataFile));
  const tsr = new Uint8Array(readFileSync(tsrFile));
  const roots = [readFileSync(caFile, 'utf8')];
  return (await verifyTimestampResponse(payload, tsr, roots)).valid;
}

const GS_PAY = fp('globalsign-payload.bin');
const GS_TSR = fp('globalsign-resp.tsr');
const GS_ROOT = fp('globalsign-root-r6.pem');
const SY_PAY = fp('synthetic-payload.bin');
const SY_ROOT = fp('synthetic-root.pem');

// Fixtures, bei denen beide Werkzeuge dieselbe Validitäts-Semantik teilen
// (genTime ≈ heute bzw. Fehlschlag aus Imprint/Kette/EKU/ESS).
const CONCORDANT: Array<{ name: string; data: string; tsr: string; ca: string }> = [
  { name: 'GlobalSign echt, korrekt', data: GS_PAY, tsr: GS_TSR, ca: GS_ROOT },
  // falscher Payload (synthetic ≠ globalsign) → Imprint passt nicht
  { name: 'GlobalSign, falscher Payload', data: SY_PAY, tsr: GS_TSR, ca: GS_ROOT },
  { name: 'Synthetik good vs eigener Root', data: SY_PAY, tsr: fp('synthetic-good.tsr'), ca: SY_ROOT },
  { name: 'Synthetik good vs GlobalSign-Root (Pinning)', data: SY_PAY, tsr: fp('synthetic-good.tsr'), ca: GS_ROOT },
  { name: 'Synthetik nicht-kritische EKU', data: SY_PAY, tsr: fp('synthetic-noncrit-eku.tsr'), ca: SY_ROOT },
  { name: 'Synthetik falscher EKU-Zweck', data: SY_PAY, tsr: fp('synthetic-wrong-eku.tsr'), ca: SY_ROOT },
  { name: 'Synthetik ohne ESS', data: SY_PAY, tsr: fp('synthetic-no-ess.tsr'), ca: SY_ROOT },
];

describe.skipIf(!hasOpenssl())('RFC-3161 Differenz-Test (pkijs vs openssl ts -verify)', () => {
  for (const c of CONCORDANT) {
    it(`gleiches Urteil: ${c.name}`, async () => {
      const ours = await pkijsValid(c.data, c.tsr, c.ca);
      const ssl = opensslVerify(c.data, c.tsr, c.ca);
      expect(ours).toBe(ssl);
    });
  }

  it('DOKUMENTIERTE Abweichung: past-valid — wir PASS (genTime), openssl FAIL (Systemuhr)', async () => {
    const ours = await pkijsValid(SY_PAY, fp('synthetic-past-valid.tsr'), SY_ROOT);
    const ssl = opensslVerify(SY_PAY, fp('synthetic-past-valid.tsr'), SY_ROOT);
    expect(ours).toBe(true); // RFC-3161-korrekt: Gültigkeit gegen genTime
    expect(ssl).toBe(false); // openssl prüft gegen die Systemuhr → Cert abgelaufen
  });
});
