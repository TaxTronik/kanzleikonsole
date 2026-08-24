// Fachkatalog: AUDIT-RFC3161-ANCHOR-001
// =============================================================================
// Krypto-Verify gegen ein ECHTES GlobalSign-Response (Review A3).
//
// Fixtures (in fixtures/, einmalig live von GlobalSign geholt):
//   globalsign-resp.tsr     — echte TimeStampResp (granted)
//   globalsign-payload.bin  — die Daten, deren sha256 als messageImprint diente
//   globalsign-root-r6.pem  — der verifizierte R6-Trust-Anchor
// Kette wird AS-OF genTime validiert → Test bleibt stabil, auch wenn das TSA-Cert
// später abläuft.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyTimestampResponse, extractTsaMeta } from '../ports/rfc3161-verify';
import { GLOBALSIGN_ROOT_R6_PEM } from '../ports/globalsign-roots';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => new Uint8Array(readFileSync(join(here, 'fixtures', n)));

const resp = fx('globalsign-resp.tsr');
const payload = fx('globalsign-payload.bin');

describe('RFC-3161 Krypto-Verify (echtes GlobalSign-Response)', () => {
  it('akzeptiert eine echte, korrekt gebundene Response (Signatur + Kette → R6, EKU)', async () => {
    const r = await verifyTimestampResponse(payload, resp, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.reason ?? '').toBe('');
    expect(r.valid).toBe(true);
    expect(r.genTime).toBeInstanceOf(Date);
    expect((r.serialHex ?? '').length).toBeGreaterThan(0);
  });

  it('lehnt ab, wenn payload nicht zum messageImprint passt (anderer Hash)', async () => {
    const wrong = new Uint8Array([...payload, 0x00]);
    const r = await verifyTimestampResponse(wrong, resp, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/messageImprint/i);
  });

  it('lehnt ab, wenn die Kette nicht zu einem vertrauten Root validiert (leerer Trust-Store)', async () => {
    const r = await verifyTimestampResponse(payload, resp, []);
    expect(r.valid).toBe(false);
  });

  it('lehnt ein manipuliertes Response-Blob ab', async () => {
    const tampered = new Uint8Array(resp);
    const i = tampered.length - 20;
    tampered[i] = (tampered[i] ?? 0) ^ 0xff;
    const r = await verifyTimestampResponse(payload, tampered, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.valid).toBe(false);
  });

  // Fall 6 (Abnahme): kaputtes/abgeschnittenes ASN.1 → sauberer FAIL mit Grund,
  // KEIN Crash, KEIN silent-true.
  it('abgeschnittenes Blob → sauberer FAIL mit Grund, kein Throw', async () => {
    const truncated = resp.slice(0, Math.floor(resp.length / 2));
    const r = await verifyTimestampResponse(payload, truncated, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.valid).toBe(false);
    expect(r.signatureValid).toBe(false);
    expect(r.reason).toBeTruthy();
    // extractTsaMeta darf bei Müll niemals werfen, sondern null liefern.
    expect(extractTsaMeta(truncated)).toBeNull();
  });

  it('Müll-Bytes (kein ASN.1) → sauberer FAIL, kein Throw', async () => {
    const garbage = new Uint8Array([0xff, 0x00, 0x13, 0x37, 0x42]);
    const r = await verifyTimestampResponse(payload, garbage, [GLOBALSIGN_ROOT_R6_PEM]);
    expect(r.valid).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(extractTsaMeta(garbage)).toBeNull();
  });
});
