// F-06: Eine eingehende x-request-id wird nur übernommen, wenn sie wohlgeformt
// und längenbegrenzt ist und keinen Freitext tragen kann.
import { describe, expect, it } from 'vitest';
import { isWellFormedRequestId, resolveRequestId } from '../log-request-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('F-06 isWellFormedRequestId', () => {
  it.each([
    ['UUID', '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'],
    ['UUID in Großbuchstaben', '3F2B8C1E-5D4A-4E6F-9A7B-1C2D3E4F5A6B'],
    ['nginx $request_id', '0123456789abcdef0123456789abcdef'],
    ['kürzestes Hex-Token', 'a'.repeat(16)],
    ['längstes Hex-Token', 'f'.repeat(64)],
  ])('akzeptiert %s', (_label, value) => {
    expect(isWellFormedRequestId(value)).toBe(true);
  });

  it.each([
    ['leer', ''],
    ['zu kurz', 'a'.repeat(15)],
    ['zu lang', 'a'.repeat(65)],
    ['E-Mail-Adresse', 'max.mustermann@example.test'],
    ['Name', 'max-mustermann-1985'],
    ['Client-IP (HAProxy-Format)', 'C0A80001:D431_0A000001:01BB_5F3E2A1B_0001:4D2'],
    ['IPv4-Adresse', '192.168.0.1'],
    ['Liste doppelter Header', '0123456789abcdef, 0123456789abcdef'],
    ['CR/LF (Log-Forging)', '0123456789abcdef\r\nlevel=error'],
    ['Leerzeichen', '0123456789abcdef '],
    ['UUID mit Zusatz', '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b-x'],
    ['Nicht-Hex', 'g'.repeat(32)],
  ])('lehnt %s ab', (_label, value) => {
    expect(isWellFormedRequestId(value)).toBe(false);
  });

  it('lehnt Nicht-Strings ab', () => {
    expect(isWellFormedRequestId(undefined)).toBe(false);
    expect(isWellFormedRequestId(null)).toBe(false);
    expect(isWellFormedRequestId(['0123456789abcdef'])).toBe(false);
  });
});

describe('F-06 resolveRequestId', () => {
  it('übernimmt eine wohlgeformte eingehende ID unverändert', () => {
    expect(resolveRequestId('0123456789abcdef0123456789abcdef')).toBe(
      '0123456789abcdef0123456789abcdef',
    );
  });

  it('vergibt für fehlende oder fehlerhafte IDs je Request eine neue UUID', () => {
    const generated = [null, undefined, '', 'max.mustermann@example.test', 'a'.repeat(65)].map(
      resolveRequestId,
    );
    for (const id of generated) expect(id).toMatch(UUID_V4);
    expect(new Set(generated).size).toBe(generated.length);
  });
});
