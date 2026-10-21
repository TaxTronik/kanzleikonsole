// =============================================================================
// Angriffsdurchlauf RT3D (kk-tcms-s11 Punkt 4): gemeinsame Regel „aktiver
// Portalzugang“. Freigaben, Risikoakzeptanzen und Codes gehen nur an Kontakte,
// deren Adresse per Portal-Anmeldung bestätigt ist und deren Mandant offen ist.
//
// Kein Befund: die Regel ist fail closed. Dieses File fixiert die
// sicherheitskritischen Invarianten gegen Umgehungsversuche (Header-Injektion
// über die Adresse, mehrere Adressen, Vorrang der Mandantsperre, fehlende
// Anmeldung) als grüne Regression.
//
// Beobachtung (kein Befund, s11 offener Punkt 5): packages/mail prüft dieselbe
// Mitteilung vor dem Versand mit einer EIGENEN, nicht auf portal-zugang
// umgestellten Kopie (tcmsMitteilungAktuell). Beide prüfen active, lastLoginAt,
// allowActive, mandateEndedAt; die Adressform prüft nur portal-zugang, die
// Adressgleichheit (to) nur packages/mail. Die Doppelung ist ein
// Wartungsrisiko, hier nicht als scheiternder Test geführt.
//
// Fachkatalog: TCMS-AKTEUR-001, MAIL-OUTBOX-001
// =============================================================================
import { describe, expect, it } from 'vitest';
import { PORTAL_EMAIL_FORM, portalZugangMangel, type PortalZugangDaten } from '../portal-zugang';

const basis = (): PortalZugangDaten => ({
  active: true,
  email: 'jana@example.test',
  lastLoginAt: new Date('2026-01-01T00:00:00Z'),
  client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
});

describe('RT3D: aktiver Portalzugang', () => {
  it('bestätigter Kontakt eines offenen Mandanten hat Zugang', () => {
    expect(portalZugangMangel(basis())).toBeNull();
    expect(portalZugangMangel({ ...basis(), email: '  jana@example.test  ' })).toBeNull();
  });

  it('Adress-Header-Injektion und Mehrfachadressen werden abgewiesen (KONTAKT_OHNE_EMAIL)', () => {
    for (const email of [
      'jana@example.test\nBcc: angriff@evil.test',
      'jana@example.test\r\nX: y',
      'jana@example.test, angriff@evil.test',
      'jana@example.test angriff@evil.test',
      'jana@@example.test',
      'plainaddress',
      '@example.test',
      'jana@localhost',
    ]) {
      expect(portalZugangMangel({ ...basis(), email }), email).toBe('KONTAKT_OHNE_EMAIL');
      expect(PORTAL_EMAIL_FORM.test(email.trim()), email).toBe(false);
    }
  });

  it('ohne Portal-Anmeldung keine bestätigte Adresse (KONTAKT_UNBESTAETIGT)', () => {
    expect(portalZugangMangel({ ...basis(), lastLoginAt: null })).toBe('KONTAKT_UNBESTAETIGT');
  });

  it('deaktivierter Kontakt (KONTAKT_INAKTIV)', () => {
    expect(portalZugangMangel({ ...basis(), active: false })).toBe('KONTAKT_INAKTIV');
  });

  it('Mandantsperre hat Vorrang vor allem (allowActive/anonymisiert/beendet → MANDANT_INAKTIV)', () => {
    for (const client of [
      { allowActive: false, anonymizedAt: null, mandateEndedAt: null },
      { allowActive: true, anonymizedAt: new Date(), mandateEndedAt: null },
      { allowActive: true, anonymizedAt: null, mandateEndedAt: new Date() },
    ]) {
      // auch mit sonst ungültigem Kontakt wird zuerst die Mandantsperre gemeldet
      expect(portalZugangMangel({ active: false, email: 'x', lastLoginAt: null, client })).toBe(
        'MANDANT_INAKTIV',
      );
    }
  });
});
