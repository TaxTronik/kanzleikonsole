// =============================================================================
// Unit-Tests: TOTP-Helfer (apps/web/src/server/auth/totp.ts).
//
// Alles pure Funktionen (node:crypto + otplib) — keine Mocks nötig.
// Abgedeckt:
//   - Secret-Verschlüsselung: Roundtrip, Tamper → wirft, falscher Tenant/
//     AUTH_SECRET → wirft (HKDF-Salt = tenantId trennt die Keys pro Tenant)
//   - Code-Verifikation deterministisch via Fake-Clock: generierter Code für
//     festes Secret + feste Zeit wird akzeptiert, falscher/veralteter Code
//     und Garbage-Input nicht (catch → false statt Exception)
//   - Secret-Generierung (Base32) und otpauth-URI
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateSync } from 'otplib';
import {
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  buildTotpUri,
  verifyTotpCode,
} from '../totp';

const AUTH_SECRET = 'unit-test-auth-secret-with-at-least-32-chars';
const TENANT_A = 'tenant-aaaa-1111';
const TENANT_B = 'tenant-bbbb-2222';
// Festes, valides Base32-Secret (RFC-4648-Alphabet) für deterministische Codes.
// 32 Zeichen (20 Byte): otplib v13 validateSecret lehnt kürzere Secrets ab;
// entspricht der Länge, die generateTotpSecret() produziert.
const SECRET_B32 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const FIXED_NOW = new Date('2026-06-09T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

// -----------------------------------------------------------------------------
// encryptTotpSecret / decryptTotpSecret
// -----------------------------------------------------------------------------

describe('encryptTotpSecret/decryptTotpSecret', () => {
  it('Roundtrip liefert das Secret zurück', () => {
    const blob = encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET);
    expect(decryptTotpSecret(blob, TENANT_A, AUTH_SECRET)).toBe(SECRET_B32);
  });

  it('zwei Verschlüsselungen unterscheiden sich (frisches IV)', () => {
    expect(encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET)).not.toBe(
      encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET),
    );
  });

  it('manipulierter Blob → wirft (GCM-AuthTag)', () => {
    const blob = encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET);
    const buf = Buffer.from(blob, 'base64');
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff; // Ciphertext-Byte kippen
    const tampered = buf.toString('base64');
    expect(() => decryptTotpSecret(tampered, TENANT_A, AUTH_SECRET)).toThrow();
  });

  it('falscher Tenant → wirft (HKDF-Salt = tenantId trennt Keys pro Tenant)', () => {
    const blob = encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET);
    expect(() => decryptTotpSecret(blob, TENANT_B, AUTH_SECRET)).toThrow();
  });

  it('falsches AUTH_SECRET → wirft', () => {
    const blob = encryptTotpSecret(SECRET_B32, TENANT_A, AUTH_SECRET);
    expect(() =>
      decryptTotpSecret(blob, TENANT_A, 'a-completely-different-secret-with-32-chars!'),
    ).toThrow();
  });
});

// -----------------------------------------------------------------------------
// generateTotpSecret / buildTotpUri
// -----------------------------------------------------------------------------

describe('generateTotpSecret', () => {
  it('liefert Base32 (RFC-4648-Alphabet), 20 Bytes → 32 Zeichen', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('zwei Secrets sind verschieden', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe('buildTotpUri', () => {
  it('baut eine otpauth://totp-URI mit Issuer, Label und Secret', () => {
    const uri = buildTotpUri('user@example.de', SECRET_B32);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('taxtronik');
    expect(uri).toContain(`secret=${SECRET_B32}`);
    // Label (E-Mail) ist URL-kodiert enthalten.
    expect(decodeURIComponent(uri)).toContain('user@example.de');
  });

  it('eigener Issuer wird übernommen', () => {
    const uri = buildTotpUri('user@example.de', SECRET_B32, 'kanzlei-x');
    expect(uri).toContain('kanzlei-x');
  });
});

// -----------------------------------------------------------------------------
// verifyTotpCode — deterministisch mit Fake-Clock
// -----------------------------------------------------------------------------

describe('verifyTotpCode', () => {
  it('akzeptiert den für (Secret, Zeit) generierten Code', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const code = generateSync({ secret: SECRET_B32 });
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(code, SECRET_B32)).toBe(true);
  });

  it('lehnt einen um eine Ziffer veränderten Code ab', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const code = generateSync({ secret: SECRET_B32 });
    const flipped = `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
    expect(verifyTotpCode(flipped, SECRET_B32)).toBe(false);
  });

  it('lehnt einen Code für ein anderes Secret ab', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const code = generateSync({ secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
    expect(verifyTotpCode(code, SECRET_B32)).toBe(false);
  });

  it('lehnt einen veralteten Code ab (10 Minuten später)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const code = generateSync({ secret: SECRET_B32 });
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 10 * 60 * 1000));
    expect(verifyTotpCode(code, SECRET_B32)).toBe(false);
  });

  it('Garbage-Input → false statt Exception (try/catch-Pfad)', () => {
    expect(verifyTotpCode('abcdef', SECRET_B32)).toBe(false);
    expect(verifyTotpCode('', SECRET_B32)).toBe(false);
    expect(verifyTotpCode('123456', 'kein-base32-secret-!!!')).toBe(false);
  });
});
