// =============================================================================
// Synthetische Negativ-Fixtures (Mini-CA) — Abnahmefälle 3, 4, 5.
//
// Erzeugt von scripts/gen-tsa-fixtures.ts (deterministisch, reproduzierbar):
//   synthetic-root.pem        — der Mini-Root (Trust-Anchor dieser Tokens)
//   synthetic-good.tsr        — gültiges TSA-Token (EKU timeStamping kritisch)
//   synthetic-noncrit-eku.tsr — EKU timeStamping NICHT kritisch  → muss FAIL
//   synthetic-wrong-eku.tsr   — EKU codeSigning (falscher Zweck) → muss FAIL
//   synthetic-past-valid.tsr  — Cert nur 2020 gültig, genTime 2020-06
//
// Diese decken ab, was `openssl ts` NICHT bauen kann (genTime-Kontrolle für
// Fall 5) bzw. was das echte GlobalSign-Fixture nicht zeigt (fremde Kette,
// kaputte EKU). Bit-rot-fest: Fall 5 prüft gegen die fixe genTime (2020-06),
// nicht gegen Date.now.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyTimestampResponse } from '../ports/rfc3161-verify';
import { GLOBALSIGN_ROOT_R6_PEM } from '../ports/globalsign-roots';

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, 'fixtures');
const bin = (n: string) => new Uint8Array(readFileSync(join(fxDir, n)));
const txt = (n: string) => readFileSync(join(fxDir, n), 'utf8');

const payload = bin('synthetic-payload.bin');
const SYNTH_ROOT = txt('synthetic-root.pem');

describe('RFC-3161 Synthetik — Fall 3: gepinnter Anchor, nicht „irgendeine konsistente Kette"', () => {
  it('Token einer fremden, selbst-konsistenten CA → gegen den GlobalSign-Root FAIL (Pinning)', async () => {
    const tsr = bin('synthetic-good.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.valid).toBe(false);
    expect(r.chainTrusted).toBe(false);
    // Beweis, dass NICHT die Signatur das Problem ist, sondern die Verankerung:
    expect(r.signatureValid).toBe(true);
  });

  it('dasselbe Token gegen den EIGENEN (Mini-)Root → valid (sonst wäre der Test wertlos)', async () => {
    const tsr = bin('synthetic-good.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [SYNTH_ROOT]);
    expect(r.reason ?? '').toBe('');
    expect(r.valid).toBe(true);
    expect(r.chainTrusted).toBe(true);
  });
});

describe('RFC-3161 Synthetik — Fall 4: EKU id-kp-timeStamping MUSS kritisch + korrekt sein', () => {
  it('EKU timeStamping NICHT kritisch → FAIL (RFC 3161 §2.3)', async () => {
    const tsr = bin('synthetic-noncrit-eku.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [SYNTH_ROOT]);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/EKU/i);
    // Kette + Signatur sind in Ordnung — NUR die EKU-Kritikalität fehlt.
    expect(r.signatureValid).toBe(true);
    expect(r.chainTrusted).toBe(true);
  });

  it('EKU codeSigning statt timeStamping → FAIL', async () => {
    const tsr = bin('synthetic-wrong-eku.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [SYNTH_ROOT]);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/EKU/i);
  });
});

describe('RFC-3161 Synthetik — Fall 5: Cert-Gültigkeit gegen genTime, nicht Date.now', () => {
  it('Cert nur 2020 gültig, genTime 2020-06, HEUTE geprüft → PASS (Schutz in die Gegenrichtung)', async () => {
    const tsr = bin('synthetic-past-valid.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [SYNTH_ROOT]);
    // Würde gegen Date.now geprüft, wäre das Cert längst abgelaufen → FAIL.
    // Es MUSS passen, weil gegen die genTime (2020-06) im Token geprüft wird.
    expect(r.reason ?? '').toBe('');
    expect(r.valid).toBe(true);
    expect(r.genTime?.getUTCFullYear()).toBe(2020);
  });
});

describe('RFC-3161 Synthetik — ESS-Bindung (RFC 3161 §2.4.1) ist Pflicht', () => {
  it('gültiges TSA-Cert, aber KEIN SigningCertificate(V2)-Attribut → FAIL', async () => {
    const tsr = bin('synthetic-no-ess.tsr');
    const r = await verifyTimestampResponse(payload, tsr, [SYNTH_ROOT]);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/ESS/i);
    // Signatur + Kette wären gültig — NUR die ESS-Bindung fehlt (wie OpenSSL es erzwingt).
    expect(r.signatureValid).toBe(true);
    expect(r.chainTrusted).toBe(true);
  });
});
