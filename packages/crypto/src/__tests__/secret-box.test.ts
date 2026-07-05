// =============================================================================
// Unit-Tests: Secret-Box (@taxtronik/crypto).
//
// Abgedeckt:
//   - Encrypt/Decrypt-Roundtrip (v2, HKDF-Key)
//   - Tamper-Tests: manipuliertes IV/AuthTag/Ciphertext → wirft (GCM)
//   - falscher Key (anderes AUTH_SECRET) → wirft
//   - v1-Migrationspfad: testseitig im alten Format (SHA-256-Key) erzeugte
//     Blobs bleiben dechiffrierbar
//   - HKDF-Pinning + Domain-Separation: gleiche Inputs, anderes Info-Label
//     → anderer Key → Decrypt wirft
//   - looksEncrypted-Strukturheuristik
//
// `@taxtronik/config` wird gemockt (Muster wie apps/web n8n/verify.test.ts) —
// kein vollständiges ENV-Setup nötig, der Krypto-Code läuft echt.
// =============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

// vi.mock-Factories werden gehoist — Shared-State über vi.hoisted().
const { TEST_SECRET } = vi.hoisted(() => ({
  TEST_SECRET: 'unit-test-auth-secret-with-at-least-32-chars',
}));

vi.mock('@taxtronik/config', () => ({
  // SECRET_BOX_KEY default undefined → Fallback auf AUTH_SECRET (N-2).
  env: { AUTH_SECRET: TEST_SECRET, SECRET_BOX_KEY: undefined },
}));

import { encryptSecret, decryptSecret, looksEncrypted } from '../index';
import { env } from '@taxtronik/config';

type MockEnv = { AUTH_SECRET: string; SECRET_BOX_KEY: string | undefined };

afterEach(() => {
  // Tests dürfen AUTH_SECRET/SECRET_BOX_KEY temporär verstellen; danach Reset.
  (env as MockEnv).AUTH_SECRET = TEST_SECRET;
  (env as MockEnv).SECRET_BOX_KEY = undefined;
});

// -----------------------------------------------------------------------------
// Helpers: Blobs testseitig EXAKT so bauen, wie der jeweilige Versions-Code
// sie schreibt — pinnt das Drahtformat gegen versehentliche Änderungen.
// -----------------------------------------------------------------------------

function buildBlob(version: string, key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** v1: deriveKey = SHA-256(AUTH_SECRET) — historisches Format ohne HKDF. */
function v1Key(authSecret = TEST_SECRET): Buffer {
  return createHash('sha256').update(authSecret).digest();
}

/** v2: HKDF-SHA256 mit gepinntem Salt + Info-Label. */
function v2Key(info = 'taxtronik-secret-box-v2', authSecret = TEST_SECRET): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      authSecret,
      Buffer.from('taxtronik-secret-box-v2-salt', 'utf8'),
      Buffer.from(info, 'utf8'),
      32,
    ),
  );
}

/** Ein Feld des Blobs (b64-dekodiert) an Byte-Position 0 kippen. */
function tamperField(blob: string, fieldIndex: 1 | 2 | 3): string {
  const parts = blob.split(':');
  const buf = Buffer.from(parts[fieldIndex]!, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  parts[fieldIndex] = buf.toString('base64');
  return parts.join(':');
}

// -----------------------------------------------------------------------------
// Roundtrip
// -----------------------------------------------------------------------------

describe('encryptSecret/decryptSecret — Roundtrip', () => {
  it('Roundtrip liefert den Plaintext zurück', () => {
    const plain = 'smtp-passwort-höchst-geheim';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('Unicode inkl. Astral-Codepoints überlebt den Roundtrip', () => {
    const plain = 'Pässwörter & Emoji: 😀';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('schreibt im aktuellen v2-Format mit 4 Feldern', () => {
    const blob = encryptSecret('x');
    const parts = blob.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v2');
  });

  it('leerer String → leerer String (beide Richtungen)', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('zwei Verschlüsselungen desselben Plaintexts unterscheiden sich (frisches IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
});

// -----------------------------------------------------------------------------
// Tamper / falscher Key
// -----------------------------------------------------------------------------

describe('decryptSecret — Manipulation und falscher Key', () => {
  it('manipuliertes IV → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim'), 1))).toThrow();
  });

  it('manipulierter AuthTag → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim'), 2))).toThrow();
  });

  it('manipulierter Ciphertext → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim'), 3))).toThrow();
  });

  it('falscher Key (anderes AUTH_SECRET) → wirft', () => {
    const blob = encryptSecret('geheim');
    (env as MockEnv).AUTH_SECRET = 'a-completely-different-secret-with-32-chars!';
    expect(() => decryptSecret(blob)).toThrow();
  });

  it('unbekannte Version → wirft mit klarer Meldung', () => {
    expect(() => decryptSecret('v3:a:b:c')).toThrow(/Unbekannte Secret-Blob-Version/);
  });

  it('falsche Feldanzahl → wirft', () => {
    expect(() => decryptSecret('kein-blob')).toThrow(/Ungültiger Secret-Blob/);
    expect(() => decryptSecret('v2:nur:drei')).toThrow(/Ungültiger Secret-Blob/);
  });
});

// -----------------------------------------------------------------------------
// v1 → v2: Bestandsdaten bleiben lesbar
// -----------------------------------------------------------------------------

describe('decryptSecret — v1-Migrationspfad', () => {
  it('v1-Blob (SHA-256-Key, altes Format) bleibt dechiffrierbar', () => {
    const blob = buildBlob('v1', v1Key(), 'altes-bestands-secret');
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decryptSecret(blob)).toBe('altes-bestands-secret');
  });

  it('v1- und v2-Key sind verschieden (Domain-Trennung der Ableitungen)', () => {
    expect(v1Key().equals(v2Key())).toBe(false);
  });

  it('v1-Key unter v2-Label → wirft (kein Cross-Version-Decrypt)', () => {
    const blob = buildBlob('v2', v1Key(), 'x');
    expect(() => decryptSecret(blob)).toThrow();
  });
});

// -----------------------------------------------------------------------------
// HKDF: Pinning + Domain-Separation
// -----------------------------------------------------------------------------

describe('HKDF v2 — Pinning und Domain-Separation', () => {
  it('testseitig mit gepinntem Salt/Info gebauter v2-Blob ist dechiffrierbar (Drahtformat-Pin)', () => {
    const blob = buildBlob('v2', v2Key(), 'pinned');
    expect(decryptSecret(blob)).toBe('pinned');
  });

  it('gleiche Inputs, anderes Info-Label → anderer Key', () => {
    expect(v2Key().equals(v2Key('taxtronik-some-other-domain'))).toBe(false);
  });

  it('Blob mit fremdem Info-Label-Key unter v2 → wirft (Domain-Separation greift)', () => {
    const blob = buildBlob('v2', v2Key('taxtronik-some-other-domain'), 'x');
    expect(() => decryptSecret(blob)).toThrow();
  });
});

// -----------------------------------------------------------------------------
// looksEncrypted
// -----------------------------------------------------------------------------

describe('looksEncrypted', () => {
  it('echter Blob → true', () => {
    expect(looksEncrypted(encryptSecret('x'))).toBe(true);
  });

  it.each([['v1:a:b:c'], ['v2:a:b:c']])('Strukturheuristik: %s → true', (v) => {
    expect(looksEncrypted(v)).toBe(true);
  });

  it.each([
    ['v3:a:b:c'],
    ['klartext-passwort'],
    ['v2:zu:viele:doppel:punkte'],
    ['v2:nur:drei'],
    [''],
  ])('%j → false', (v) => {
    expect(looksEncrypted(v)).toBe(false);
  });

  it('null/undefined → false', () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// N-1: harte IV/Tag-Längenprüfung vor createDecipheriv
// -----------------------------------------------------------------------------

describe('decryptSecret — N-1: IV/Tag-Längenprüfung', () => {
  /** Ein Feld des Blobs durch beliebige Bytes ersetzen (b64-kodiert). */
  function replaceField(blob: string, fieldIndex: 1 | 2 | 3, bytes: Buffer): string {
    const parts = blob.split(':');
    parts[fieldIndex] = bytes.toString('base64');
    return parts.join(':');
  }

  it('verkürzter Auth-Tag (4 Byte) → wirft mit klarer Meldung statt zu akzeptieren', () => {
    // Ohne Prüfung würde Node bei GCM einen 4-Byte-Tag via setAuthTag
    // schlucken → Forgery-Hürde gesenkt. Mit N-1 ein harter Fehler.
    const blob = replaceField(encryptSecret('geheim'), 2, randomBytes(4));
    expect(() => decryptSecret(blob)).toThrow(/IV\/Tag-Länge/);
  });

  it('leerer Auth-Tag (0 Byte) → wirft', () => {
    const blob = replaceField(encryptSecret('geheim'), 2, Buffer.alloc(0));
    expect(() => decryptSecret(blob)).toThrow(/IV\/Tag-Länge/);
  });

  it('zu langes IV (16 Byte) → wirft', () => {
    const blob = replaceField(encryptSecret('geheim'), 1, randomBytes(16));
    expect(() => decryptSecret(blob)).toThrow(/IV\/Tag-Länge/);
  });

  it('korrekte Längen (IV 12 / Tag 16) passieren die Prüfung (Roundtrip ok)', () => {
    expect(decryptSecret(encryptSecret('geheim'))).toBe('geheim');
  });
});

// -----------------------------------------------------------------------------
// N-2: optionaler SECRET_BOX_KEY als HKDF-IKM (AUTH_SECRET-Entkopplung)
// -----------------------------------------------------------------------------

describe('SECRET_BOX_KEY — N-2: dedizierter Box-Key + Fallback', () => {
  const BOX_KEY = 'dedicated-secret-box-key-with-32-plus-chars';

  it('ohne SECRET_BOX_KEY: Verhalten unverändert (Fallback AUTH_SECRET)', () => {
    (env as MockEnv).SECRET_BOX_KEY = undefined;
    expect(decryptSecret(encryptSecret('geheim'))).toBe('geheim');
  });

  it('mit SECRET_BOX_KEY: Roundtrip funktioniert', () => {
    (env as MockEnv).SECRET_BOX_KEY = BOX_KEY;
    expect(decryptSecret(encryptSecret('geheim'))).toBe('geheim');
  });

  it('SECRET_BOX_KEY entkoppelt von AUTH_SECRET: AUTH_SECRET-Rotation lässt Blob lesbar', () => {
    (env as MockEnv).SECRET_BOX_KEY = BOX_KEY;
    const blob = encryptSecret('rotations-fest');
    // AUTH_SECRET rotieren — der Box-Key hängt jetzt an SECRET_BOX_KEY.
    (env as MockEnv).AUTH_SECRET = 'rotated-auth-secret-with-32-plus-chars!';
    expect(decryptSecret(blob)).toBe('rotations-fest');
  });

  it('gesetzter SECRET_BOX_KEY erzeugt anderen Key als der AUTH_SECRET-Fallback', () => {
    (env as MockEnv).SECRET_BOX_KEY = undefined;
    const fallbackBlob = encryptSecret('x');
    (env as MockEnv).SECRET_BOX_KEY = BOX_KEY;
    // Mit anderem IKM ist der v2-Key anders → der Fallback-Blob ist nicht mehr
    // dechiffrierbar (belegt, dass SECRET_BOX_KEY tatsächlich greift).
    expect(() => decryptSecret(fallbackBlob)).toThrow();
  });
});
