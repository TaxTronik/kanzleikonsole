// =============================================================================
// Unit-Tests: Secret-Box (@taxtronik/crypto).
//
// Abgedeckt:
//   - Encrypt/Decrypt-Roundtrip (v3, Schlüsselbund, AAD-Kontext)
//   - Tamper-Tests: manipuliertes IV/AuthTag/Ciphertext/Key-ID → wirft (GCM)
//   - S-08: Kontextbindung — ein in einen anderen Tenant, eine andere Zeile,
//     ein anderes Setting oder Feld kopierter v3-Wert ist nicht entschlüsselbar
//   - S-08: Schlüsselbund, Rotation ohne Ausfallzeit, Re-Wrap (idempotent,
//     Klartext unverändert)
//   - falscher Key (anderes AUTH_SECRET) → wirft
//   - v1-/v2-Migrationspfad: testseitig im alten Format erzeugte Blobs bleiben
//     dechiffrierbar (auch über einen Schlüsselbund-Eintrag)
//   - HKDF-Pinning + Domain-Separation
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
  env: { AUTH_SECRET: TEST_SECRET, SECRET_BOX_KEY: undefined, SECRET_BOX_KEYRING: [] },
}));

import {
  activeSecretBoxKeyId,
  configuredSecretBoxKeyIds,
  decryptSecret,
  describeSecretBlob,
  encryptSecret,
  looksEncrypted,
  readEncryptedSetting,
  rewrapSecret,
  type SecretContext,
} from '../index';
import { env } from '@taxtronik/config';

type MockEnv = {
  AUTH_SECRET: string;
  SECRET_BOX_KEY: string | undefined;
  SECRET_BOX_KEYRING: string[] | undefined;
};
const mockEnv = env as unknown as MockEnv;

afterEach(() => {
  // Tests dürfen die Schlüssel temporär verstellen; danach Reset.
  mockEnv.AUTH_SECRET = TEST_SECRET;
  mockEnv.SECRET_BOX_KEY = undefined;
  mockEnv.SECRET_BOX_KEYRING = [];
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SMTP: SecretContext = {
  tenantId: TENANT_A,
  scope: 'tenant_setting/mail.smtp',
  field: 'passwordEncrypted',
};
const KEY_1 = 'secret-box-data-key-one-with-more-than-32-chars';
const KEY_2 = 'secret-box-data-key-two-with-more-than-32-chars';

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

/** v3: Schlüssel und Key-ID als getrennte HKDF-Ausgaben mit gepinntem Salt. */
function v3Hkdf(ikm: string, info: string, length: number): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      ikm,
      Buffer.from('taxtronik-secret-box-v3-salt', 'utf8'),
      Buffer.from(info, 'utf8'),
      length,
    ),
  );
}

function v3KeyId(ikm: string): string {
  return v3Hkdf(ikm, 'taxtronik-secret-box-v3-key-id', 8).toString('hex');
}

/** v3-Blob testseitig nach der dokumentierten Spezifikation bauen. */
function buildV3Blob(ikm: string, plain: string, context: string): string {
  const keyId = v3KeyId(ikm);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', v3Hkdf(ikm, 'taxtronik-secret-box-v3', 32), iv);
  cipher.setAAD(Buffer.from(`taxtronik-secret-box-v3|${keyId}|${context}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v3',
    keyId,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');
}

/** Ein Feld des Blobs (b64-dekodiert) an Byte-Position 0 kippen. */
function tamperField(blob: string, fieldIndex: number): string {
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
    expect(decryptSecret(encryptSecret(plain, SMTP), SMTP)).toBe(plain);
  });

  it('Unicode inkl. Astral-Codepoints überlebt den Roundtrip', () => {
    const plain = 'Pässwörter & Emoji: 😀';
    expect(decryptSecret(encryptSecret(plain, SMTP), SMTP)).toBe(plain);
  });

  it('schreibt im aktuellen v3-Format mit Key-ID und 5 Feldern', () => {
    const parts = encryptSecret('x', SMTP).split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v3');
    expect(parts[1]).toBe(v3KeyId(TEST_SECRET));
    expect(parts[1]).toBe(activeSecretBoxKeyId());
  });

  it('leerer String → leerer String (beide Richtungen)', () => {
    expect(encryptSecret('', SMTP)).toBe('');
    expect(decryptSecret('', SMTP)).toBe('');
  });

  it('zwei Verschlüsselungen desselben Plaintexts unterscheiden sich (frisches IV)', () => {
    expect(encryptSecret('same', SMTP)).not.toBe(encryptSecret('same', SMTP));
  });

  it('pinnt das v3-Drahtformat: testseitig nach Spezifikation gebauter Blob ist lesbar', () => {
    const blob = buildV3Blob(
      TEST_SECRET,
      'pinned',
      `${TENANT_A}|tenant_setting/mail.smtp|passwordEncrypted`,
    );
    expect(decryptSecret(blob, SMTP)).toBe('pinned');
  });
});

// -----------------------------------------------------------------------------
// S-08: Kontextbindung (AAD)
// -----------------------------------------------------------------------------

describe('S-08 — v3-Werte sind an Tenant, Ablageort und Feld gebunden', () => {
  const blob = () => encryptSecret('smtp-passwort', SMTP);

  it('in einen anderen Tenant kopiert → nicht entschlüsselbar', () => {
    expect(() => decryptSecret(blob(), { ...SMTP, tenantId: TENANT_B })).toThrow();
  });

  it('in ein anderes Feld desselben Settings kopiert → nicht entschlüsselbar', () => {
    expect(() => decryptSecret(blob(), { ...SMTP, field: 'apiKeyEncrypted' })).toThrow();
  });

  it('in ein anderes Setting kopiert → nicht entschlüsselbar', () => {
    expect(() =>
      decryptSecret(blob(), { ...SMTP, scope: 'tenant_setting/quantenlos.ibm' }),
    ).toThrow();
  });

  it('in eine andere Zeile derselben Tabelle kopiert → nicht entschlüsselbar', () => {
    const mailbox = (id: string): SecretContext => ({
      tenantId: TENANT_A,
      scope: `inbound_mailbox/${id}`,
      field: 'secret_enc',
    });
    const value = encryptSecret('imap-passwort', mailbox('row-1'));
    expect(decryptSecret(value, mailbox('row-1'))).toBe('imap-passwort');
    expect(() => decryptSecret(value, mailbox('row-2'))).toThrow();
  });

  it('readEncryptedSetting meldet den kopierten Wert als Entschlüsselungsfehler statt Klartext', () => {
    const onError = vi.fn();
    const copied = readEncryptedSetting(
      blob(),
      undefined,
      'smtp.password',
      { ...SMTP, tenantId: TENANT_B },
      onError,
    );
    expect(copied).toBe('');
    expect(onError).toHaveBeenCalledWith('smtp.password', expect.any(Error));
    expect(readEncryptedSetting(blob(), undefined, 'smtp.password', SMTP)).toBe('smtp-passwort');
  });

  it('die Kontext-Bestandteile sind eindeutig: `|` und Steuerzeichen werden abgewiesen', () => {
    const ambiguous = { tenantId: TENANT_A, scope: 'tenant_setting/a|b', field: 'c' };
    expect(() => encryptSecret('x', ambiguous)).toThrow(/Secret-Box-Kontext/);
    expect(() => decryptSecret('', { ...SMTP, field: 'feld\n' })).toThrow(/Secret-Box-Kontext/);
    expect(() => encryptSecret('x', { ...SMTP, tenantId: '' })).toThrow(/Secret-Box-Kontext/);
  });

  it('manipulierte Key-ID → wirft (Schlüssel unbekannt)', () => {
    const parts = blob().split(':');
    parts[1] = '0123456789abcdef';
    expect(() => decryptSecret(parts.join(':'), SMTP)).toThrow(/nicht konfiguriert/);
  });
});

// -----------------------------------------------------------------------------
// Tamper / falscher Key
// -----------------------------------------------------------------------------

describe('decryptSecret — Manipulation und falscher Key', () => {
  it('manipuliertes IV → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim', SMTP), 2), SMTP)).toThrow();
  });

  it('manipulierter AuthTag → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim', SMTP), 3), SMTP)).toThrow();
  });

  it('manipulierter Ciphertext → wirft', () => {
    expect(() => decryptSecret(tamperField(encryptSecret('geheim', SMTP), 4), SMTP)).toThrow();
  });

  it('falscher Key (anderes AUTH_SECRET) → wirft', () => {
    const blob = encryptSecret('geheim', SMTP);
    mockEnv.AUTH_SECRET = 'a-completely-different-secret-with-32-chars!';
    expect(() => decryptSecret(blob, SMTP)).toThrow();
  });

  it('unbekannte Version → wirft mit klarer Meldung', () => {
    expect(() => decryptSecret('v9:a:b:c', SMTP)).toThrow(/Unbekannte Secret-Blob-Version/);
  });

  it('falsche Feldanzahl → wirft', () => {
    expect(() => decryptSecret('kein-blob', SMTP)).toThrow(/Ungültiger Secret-Blob/);
    expect(() => decryptSecret('v2:nur:drei', SMTP)).toThrow(/Ungültiger Secret-Blob/);
    expect(() => decryptSecret('v3:a:b:c', SMTP)).toThrow(/Ungültiger Secret-Blob/);
    expect(() => decryptSecret('v3:KEINE-ID:a:b:c', SMTP)).toThrow(/Ungültiger Secret-Blob/);
  });
});

// -----------------------------------------------------------------------------
// v1/v2: Bestandsdaten bleiben lesbar
// -----------------------------------------------------------------------------

describe('decryptSecret — v1-/v2-Migrationspfad', () => {
  it('v1-Blob (SHA-256-Key, altes Format) bleibt dechiffrierbar', () => {
    const blob = buildBlob('v1', v1Key(), 'altes-bestands-secret');
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decryptSecret(blob, SMTP)).toBe('altes-bestands-secret');
  });

  it('v2-Blob bleibt dechiffrierbar — unabhängig vom übergebenen Kontext (keine AAD)', () => {
    const blob = buildBlob('v2', v2Key(), 'bestand-v2');
    expect(decryptSecret(blob, SMTP)).toBe('bestand-v2');
    expect(decryptSecret(blob, { ...SMTP, tenantId: TENANT_B })).toBe('bestand-v2');
  });

  it('v1- und v2-Key sind verschieden (Domain-Trennung der Ableitungen)', () => {
    expect(v1Key().equals(v2Key())).toBe(false);
  });

  it('v1-Key unter v2-Label → wirft (kein Cross-Version-Decrypt)', () => {
    const blob = buildBlob('v2', v1Key(), 'x');
    expect(() => decryptSecret(blob, SMTP)).toThrow();
  });

  it('v1/v2 nach einem Wurzelwechsel: lesbar, solange die alte Wurzel im Schlüsselbund steht', () => {
    const v1 = buildBlob('v1', v1Key(), 'vor-auth-secret-rotation');
    const v2 = buildBlob('v2', v2Key(), 'vor-box-key-wechsel');
    mockEnv.AUTH_SECRET = 'rotated-auth-secret-with-at-least-32-chars!';
    mockEnv.SECRET_BOX_KEY = 'new-dedicated-root-key-with-more-than-32-chars';
    expect(() => decryptSecret(v1, SMTP)).toThrow();
    expect(() => decryptSecret(v2, SMTP)).toThrow();
    mockEnv.SECRET_BOX_KEYRING = [KEY_1, TEST_SECRET];
    expect(decryptSecret(v1, SMTP)).toBe('vor-auth-secret-rotation');
    expect(decryptSecret(v2, SMTP)).toBe('vor-box-key-wechsel');
  });
});

// -----------------------------------------------------------------------------
// HKDF: Pinning + Domain-Separation
// -----------------------------------------------------------------------------

describe('HKDF v2 — Pinning und Domain-Separation', () => {
  it('testseitig mit gepinntem Salt/Info gebauter v2-Blob ist dechiffrierbar (Drahtformat-Pin)', () => {
    const blob = buildBlob('v2', v2Key(), 'pinned');
    expect(decryptSecret(blob, SMTP)).toBe('pinned');
  });

  it('gleiche Inputs, anderes Info-Label → anderer Key', () => {
    expect(v2Key().equals(v2Key('taxtronik-some-other-domain'))).toBe(false);
  });

  it('Blob mit fremdem Info-Label-Key unter v2 → wirft (Domain-Separation greift)', () => {
    const blob = buildBlob('v2', v2Key('taxtronik-some-other-domain'), 'x');
    expect(() => decryptSecret(blob, SMTP)).toThrow();
  });

  it('v3-Schlüssel, v3-Key-ID und v2-Schlüssel sind getrennte Ableitungen', () => {
    const v3 = v3Hkdf(TEST_SECRET, 'taxtronik-secret-box-v3', 32);
    expect(v3.equals(v2Key())).toBe(false);
    expect(v3.subarray(0, 8).toString('hex')).not.toBe(v3KeyId(TEST_SECRET));
  });
});

// -----------------------------------------------------------------------------
// looksEncrypted
// -----------------------------------------------------------------------------

describe('looksEncrypted', () => {
  it('echter Blob → true', () => {
    expect(looksEncrypted(encryptSecret('x', SMTP))).toBe(true);
  });

  it.each([['v1:a:b:c'], ['v2:a:b:c'], ['v3:0123456789abcdef:a:b:c']])(
    'Strukturheuristik: %s → true',
    (v) => {
      expect(looksEncrypted(v)).toBe(true);
    },
  );

  it.each([
    ['v3:a:b:c'],
    ['v3:not-a-key-id:a:b:c'],
    ['v9:a:b:c'],
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
  function replaceField(blob: string, fieldIndex: number, bytes: Buffer): string {
    const parts = blob.split(':');
    parts[fieldIndex] = bytes.toString('base64');
    return parts.join(':');
  }

  it('verkürzter Auth-Tag (4 Byte) → wirft mit klarer Meldung statt zu akzeptieren', () => {
    // Ohne Prüfung würde Node bei GCM einen 4-Byte-Tag via setAuthTag
    // schlucken → Forgery-Hürde gesenkt. Mit N-1 ein harter Fehler.
    const blob = replaceField(encryptSecret('geheim', SMTP), 3, randomBytes(4));
    expect(() => decryptSecret(blob, SMTP)).toThrow(/IV\/Tag-Länge/);
  });

  it('leerer Auth-Tag (0 Byte) → wirft', () => {
    const blob = replaceField(encryptSecret('geheim', SMTP), 3, Buffer.alloc(0));
    expect(() => decryptSecret(blob, SMTP)).toThrow(/IV\/Tag-Länge/);
  });

  it('zu langes IV (16 Byte) → wirft', () => {
    const blob = replaceField(encryptSecret('geheim', SMTP), 2, randomBytes(16));
    expect(() => decryptSecret(blob, SMTP)).toThrow(/IV\/Tag-Länge/);
  });

  it('auch v2-Blobs: verkürzter Auth-Tag → wirft', () => {
    const blob = replaceField(buildBlob('v2', v2Key(), 'geheim'), 2, randomBytes(4));
    expect(() => decryptSecret(blob, SMTP)).toThrow(/IV\/Tag-Länge/);
  });

  it('korrekte Längen (IV 12 / Tag 16) passieren die Prüfung (Roundtrip ok)', () => {
    expect(decryptSecret(encryptSecret('geheim', SMTP), SMTP)).toBe('geheim');
  });
});

// -----------------------------------------------------------------------------
// N-2: optionaler SECRET_BOX_KEY als Wurzel-IKM (AUTH_SECRET-Entkopplung)
// -----------------------------------------------------------------------------

describe('SECRET_BOX_KEY — N-2: dedizierte Wurzel + Fallback', () => {
  const BOX_KEY = 'dedicated-secret-box-key-with-32-plus-chars';

  it('ohne SECRET_BOX_KEY: Verhalten unverändert (Fallback AUTH_SECRET)', () => {
    expect(decryptSecret(encryptSecret('geheim', SMTP), SMTP)).toBe('geheim');
    expect(activeSecretBoxKeyId()).toBe(v3KeyId(TEST_SECRET));
  });

  it('mit SECRET_BOX_KEY: Roundtrip funktioniert, Key-ID stammt aus SECRET_BOX_KEY', () => {
    mockEnv.SECRET_BOX_KEY = BOX_KEY;
    expect(decryptSecret(encryptSecret('geheim', SMTP), SMTP)).toBe('geheim');
    expect(activeSecretBoxKeyId()).toBe(v3KeyId(BOX_KEY));
  });

  it('SECRET_BOX_KEY entkoppelt von AUTH_SECRET: AUTH_SECRET-Rotation lässt Blob lesbar', () => {
    mockEnv.SECRET_BOX_KEY = BOX_KEY;
    const blob = encryptSecret('rotations-fest', SMTP);
    mockEnv.AUTH_SECRET = 'rotated-auth-secret-with-32-plus-chars!';
    expect(decryptSecret(blob, SMTP)).toBe('rotations-fest');
  });

  it('gesetzter SECRET_BOX_KEY erzeugt anderen Key als der AUTH_SECRET-Fallback', () => {
    const fallbackBlob = encryptSecret('x', SMTP);
    mockEnv.SECRET_BOX_KEY = BOX_KEY;
    // Die AUTH_SECRET-Wurzel ist danach nicht mehr konfiguriert → ihr v3-Blob
    // ist ohne Schlüsselbund-Eintrag nicht mehr dechiffrierbar.
    expect(() => decryptSecret(fallbackBlob, SMTP)).toThrow(/nicht konfiguriert/);
  });
});

// -----------------------------------------------------------------------------
// S-08: Schlüsselbund, Rotation, Re-Wrap
// -----------------------------------------------------------------------------

describe('S-08 — Schlüsselbund und Rotation', () => {
  it('der erste Schlüsselbund-Eintrag verschlüsselt, die Wurzel entschlüsselt weiter', () => {
    const rootBlob = encryptSecret('vor-rotation', SMTP);
    mockEnv.SECRET_BOX_KEYRING = [KEY_1];
    const ringBlob = encryptSecret('nach-rotation', SMTP);
    expect(ringBlob.split(':')[1]).toBe(v3KeyId(KEY_1));
    expect(decryptSecret(rootBlob, SMTP)).toBe('vor-rotation');
    expect(decryptSecret(ringBlob, SMTP)).toBe('nach-rotation');
    expect(configuredSecretBoxKeyIds()).toEqual([v3KeyId(KEY_1), v3KeyId(TEST_SECRET)]);
  });

  it('Rotation ohne Ausfallzeit: Verteilen → Aktivieren → Re-Wrap → Entfernen', () => {
    mockEnv.SECRET_BOX_KEYRING = [KEY_1];
    const before = encryptSecret('geheim', SMTP);
    // Phase 1: neuer Schlüssel nur als weiterer Eintrag; KEY_1 verschlüsselt weiter.
    mockEnv.SECRET_BOX_KEYRING = [KEY_1, KEY_2];
    expect(encryptSecret('x', SMTP).split(':')[1]).toBe(v3KeyId(KEY_1));
    // Ein Prozess, der schon Phase 2 kennt, schreibt mit KEY_2 — Phase-1-
    // Prozesse lesen das bereits.
    mockEnv.SECRET_BOX_KEYRING = [KEY_2, KEY_1];
    const written = encryptSecret('neu', SMTP);
    mockEnv.SECRET_BOX_KEYRING = [KEY_1, KEY_2];
    expect(decryptSecret(written, SMTP)).toBe('neu');
    // Phase 2/3: KEY_2 aktiv, Re-Wrap stellt Bestand um.
    mockEnv.SECRET_BOX_KEYRING = [KEY_2, KEY_1];
    const rewrapped = rewrapSecret(before, SMTP);
    expect(rewrapped.changed).toBe(true);
    expect(describeSecretBlob(rewrapped.blob)).toEqual({ version: 'v3', keyId: v3KeyId(KEY_2) });
    // Phase 4: KEY_1 entfernt — der umgestellte Wert bleibt lesbar, der alte nicht.
    mockEnv.SECRET_BOX_KEYRING = [KEY_2];
    expect(decryptSecret(rewrapped.blob, SMTP)).toBe('geheim');
    expect(() => decryptSecret(before, SMTP)).toThrow(/nicht konfiguriert/);
  });

  it('ein Eintrag gleich der Wurzel wird nur einmal geführt', () => {
    mockEnv.SECRET_BOX_KEYRING = [TEST_SECRET, KEY_1];
    expect(configuredSecretBoxKeyIds()).toEqual([v3KeyId(TEST_SECRET), v3KeyId(KEY_1)]);
    expect(activeSecretBoxKeyId()).toBe(v3KeyId(TEST_SECRET));
  });

  it('die Key-ID verrät den Schlüssel nicht: 16 Hex-Zeichen aus eigenem HKDF-Label', () => {
    const keyId = activeSecretBoxKeyId();
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyId).not.toBe(createHash('sha256').update(TEST_SECRET).digest('hex').slice(0, 16));
  });
});

describe('S-08 — rewrapSecret', () => {
  it.each([
    ['v1', () => buildBlob('v1', v1Key(), 'klartext-v1')],
    ['v2', () => buildBlob('v2', v2Key(), 'klartext-v2')],
  ])('%s → v3 mit aktivem Schlüssel, Klartext unverändert', (_version, build) => {
    mockEnv.SECRET_BOX_KEYRING = [KEY_1];
    const blob = build();
    const plain = decryptSecret(blob, SMTP);
    const result = rewrapSecret(blob, SMTP);
    expect(result.changed).toBe(true);
    expect(describeSecretBlob(result.blob)).toEqual({ version: 'v3', keyId: v3KeyId(KEY_1) });
    expect(decryptSecret(result.blob, SMTP)).toBe(plain);
  });

  it('ist idempotent: ein mit dem aktiven Schlüssel geschriebener v3-Wert bleibt unverändert', () => {
    const blob = encryptSecret('schon-aktuell', SMTP);
    expect(rewrapSecret(blob, SMTP)).toEqual({ blob, changed: false });
  });

  it('bindet den neuen Wert an denselben Kontext', () => {
    mockEnv.SECRET_BOX_KEYRING = [KEY_1, TEST_SECRET];
    const blob = buildBlob('v2', v2Key(), 'gebunden');
    const { blob: next } = rewrapSecret(blob, SMTP);
    expect(() => decryptSecret(next, { ...SMTP, tenantId: TENANT_B })).toThrow();
  });

  it('nicht entschlüsselbare oder in fremden Kontext kopierte Werte werden nicht umgeschrieben', () => {
    const foreign = encryptSecret('anderer-tenant', { ...SMTP, tenantId: TENANT_B });
    mockEnv.SECRET_BOX_KEYRING = [KEY_1];
    expect(() => rewrapSecret(foreign, SMTP)).toThrow();
    expect(() => rewrapSecret(tamperField(buildBlob('v2', v2Key(), 'x'), 3), SMTP)).toThrow();
  });

  it('leerer Wert bleibt leer', () => {
    expect(rewrapSecret('', SMTP)).toEqual({ blob: '', changed: false });
  });
});
