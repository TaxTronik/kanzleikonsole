// =============================================================================
// Unit-Tests: iCal-Feed-Token (apps/web/src/server/ical/feed.ts).
//
// Audit 2026-06 Befund 3: Der Token trägt seit iter84 eine pro-Kontakt
// rotierbare Versionsnummer (`<contactId>.<version>.<hmac>`), die Teil des
// HMAC-Payloads ist. Hier abgedeckt:
//   - Roundtrip sign → verify (contactId + Version kommen unverändert zurück)
//   - Manipulation: Signatur, contactId oder Version verändert → null
//   - Altes zweiteiliges Format (vor iter84) → null (Versions-Check gilt
//     ausnahmslos, keine Legacy-Hintertür)
//   - Garbage/Format-Grenzfälle → null
// Der Versions-VERGLEICH gegen die DB (icalTokenVersion) liegt in der Route
// (api/portal/ical/[token]) — hier nur die kryptographische Schicht.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { createHmac, hkdfSync } from 'node:crypto';

const AUTH_SECRET = 'test-secret-mit-mindestens-32-zeichen!!';

vi.mock('@taxtronik/config', () => ({
  env: { AUTH_SECRET: 'test-secret-mit-mindestens-32-zeichen!!' },
}));

import { signIcalToken, verifyIcalToken } from '../feed';

const CONTACT_ID = '6f1f5e7a-1234-4abc-9def-0123456789ab';

/** Repliziert die HKDF/HMAC-Ableitung aus feed.ts für Negativ-Konstruktionen. */
function forgeSig(payload: string): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      AUTH_SECRET,
      Buffer.from('taxtronik-ical-salt', 'utf8'),
      Buffer.from('taxtronik-ical-token-v1', 'utf8'),
      32,
    ),
  );
  return createHmac('sha256', key).update(payload).digest('base64url');
}

describe('signIcalToken', () => {
  it('Format <contactId>.<version>.<sig>; Version im Klartext lesbar', () => {
    const token = signIcalToken(CONTACT_ID, 3);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(CONTACT_ID);
    expect(parts[1]).toBe('3');
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 Byte base64url
  });

  it('verschiedene Versionen → verschiedene Signaturen (Version ist im HMAC)', () => {
    const sig1 = signIcalToken(CONTACT_ID, 1).split('.')[2];
    const sig2 = signIcalToken(CONTACT_ID, 2).split('.')[2];
    expect(sig1).not.toBe(sig2);
  });
});

describe('verifyIcalToken — Roundtrip', () => {
  it('gültiger Token → contactId + Version', () => {
    expect(verifyIcalToken(signIcalToken(CONTACT_ID, 1))).toEqual({
      contactId: CONTACT_ID,
      version: 1,
    });
    expect(verifyIcalToken(signIcalToken(CONTACT_ID, 42))).toEqual({
      contactId: CONTACT_ID,
      version: 42,
    });
  });
});

describe('verifyIcalToken — Manipulation', () => {
  it('verfälschte Signatur → null', () => {
    const token = signIcalToken(CONTACT_ID, 1);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(verifyIcalToken(flipped)).toBeNull();
  });

  it('Version hochgedreht ohne Re-Signatur → null (kein Self-Service-Upgrade)', () => {
    const [id, , sig] = signIcalToken(CONTACT_ID, 1).split('.');
    expect(verifyIcalToken(`${id}.2.${sig}`)).toBeNull();
  });

  it('Signatur einer anderen contactId wiederverwendet → null', () => {
    const otherId = '00000000-0000-4000-8000-000000000000';
    const sig = signIcalToken(otherId, 1).split('.')[2];
    expect(verifyIcalToken(`${CONTACT_ID}.1.${sig}`)).toBeNull();
  });
});

describe('verifyIcalToken — Format-Grenzfälle', () => {
  it('altes zweiteiliges Format (vor iter84, HMAC nur über contactId) → null', () => {
    // So sahen Tokens vor der Versionierung aus — bewusst KEIN Legacy-Pfad.
    const legacySig = forgeSig(CONTACT_ID);
    expect(verifyIcalToken(`${CONTACT_ID}.${legacySig}`)).toBeNull();
  });

  it('Garbage, leer, falsche Teil-Anzahl → null', () => {
    expect(verifyIcalToken('')).toBeNull();
    expect(verifyIcalToken('kein-token')).toBeNull();
    expect(verifyIcalToken('a.b.c.d')).toBeNull();
    expect(verifyIcalToken(`.1.${forgeSig('.1')}`)).toBeNull(); // leere contactId
  });

  it('nicht-numerische oder überlange Version → null, auch korrekt signiert', () => {
    // Die Version muss /^\d{1,9}$/ matchen — selbst eine gültige Signatur
    // über einen abweichenden Payload darf das nicht aushebeln.
    expect(verifyIcalToken(`${CONTACT_ID}.x.${forgeSig(`${CONTACT_ID}.x`)}`)).toBeNull();
    expect(verifyIcalToken(`${CONTACT_ID}.-1.${forgeSig(`${CONTACT_ID}.-1`)}`)).toBeNull();
    const huge = '1234567890'; // 10 Stellen > Limit
    expect(
      verifyIcalToken(`${CONTACT_ID}.${huge}.${forgeSig(`${CONTACT_ID}.${huge}`)}`),
    ).toBeNull();
  });
});
