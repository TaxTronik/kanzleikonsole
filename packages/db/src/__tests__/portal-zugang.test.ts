// =============================================================================
// kk-tcms-s11 Punkt 4 (TCMS-AKTEUR-001, MAIL-OUTBOX-001): eine Regel für den
// aktiven Portalzugang eines Mandantenkontakts – die Web-App adressiert
// Freigaben nur danach, der Zustell-Worker stellt nur danach zu. Reine
// Funktion; die Anwendung gegen PostgreSQL belegen namen-personen-db.test.ts
// (Web) und tcms-nachrichten-db.test.ts (Worker).
// Fachkatalog: TCMS-AKTEUR-001
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  aktiverPortalzugangWhere,
  MANDANT_PORTAL_OFFEN,
  PORTAL_EMAIL_FORM,
  portalZugangMangel,
  type PortalZugangDaten,
} from '../portal-zugang';

const OK: PortalZugangDaten = {
  active: true,
  email: ' jana.weller@talwind.example ',
  lastLoginAt: new Date('2026-10-01T08:00:00Z'),
  client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
};
const mit = (o: Partial<PortalZugangDaten>, c: Partial<PortalZugangDaten['client']> = {}) => ({
  ...OK,
  ...o,
  client: { ...OK.client, ...c },
});

describe('portalZugangMangel', () => {
  it('aktiver Kontakt mit bestätigter Adresse beim zugelassenen Mandanten: kein Mangel', () => {
    expect(portalZugangMangel(OK)).toBeNull();
  });

  it('Mandant nicht zugelassen, anonymisiert oder Mandat beendet: MANDANT_INAKTIV (vor allem anderen)', () => {
    const datum = new Date('2026-09-30T00:00:00Z');
    for (const c of [{ allowActive: false }, { anonymizedAt: datum }, { mandateEndedAt: datum }]) {
      expect(portalZugangMangel(mit({ active: false, lastLoginAt: null }, c))).toBe(
        'MANDANT_INAKTIV',
      );
    }
  });

  it('inaktiver Kontakt: KONTAKT_INAKTIV (vor Adresse und Anmeldung)', () => {
    expect(portalZugangMangel(mit({ active: false, email: 'x', lastLoginAt: null }))).toBe(
      'KONTAKT_INAKTIV',
    );
  });

  it('Adresse ohne zustellbare Form: KONTAKT_OHNE_EMAIL', () => {
    for (const email of ['', 'jana', 'jana@talwind', 'ja na@talwind.example', '@talwind.example']) {
      expect(portalZugangMangel(mit({ email })), email).toBe('KONTAKT_OHNE_EMAIL');
    }
  });

  it('nie angemeldet (Adresse unbestätigt): KONTAKT_UNBESTAETIGT', () => {
    expect(portalZugangMangel(mit({ lastLoginAt: null }))).toBe('KONTAKT_UNBESTAETIGT');
  });

  it('Filter und Form passen zur Funktion', () => {
    expect(aktiverPortalzugangWhere('t', 'm')).toEqual({
      tenantId: 't',
      clientId: 'm',
      active: true,
      lastLoginAt: { not: null },
      client: MANDANT_PORTAL_OFFEN,
    });
    expect(PORTAL_EMAIL_FORM.test('a@b.c')).toBe(true);
    expect(PORTAL_EMAIL_FORM.test('a@b')).toBe(false);
  });
});
