// =============================================================================
// TCMS Stufe 3 (Integration, TCMS s6): Grund der Meldung „unzustellbar“ an das
// Tax-CMS. Die Abbildung der eigenen Gründe ist vollständig, nutzt nur Gründe
// des Vertrags und ist fest; unbekannte Werte (Drift der Datenbank) und
// Prototyp-Schlüssel werden zu SONSTIGES, nie zu einem Fehler oder Freitext.
// Den Ablauf (Grund vor dem Senden, Wiederholung mit demselben Grund, 409 =
// erledigt) belegt tcms-nachrichten-db.test.ts.
//
// Fachkatalog: MAIL-OUTBOX-001
// =============================================================================

import { describe, expect, it, vi } from 'vitest';

// Nur die reine Abbildung: keine Datenbank, keine Konfiguration.
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../notify', () => ({ notify: vi.fn() }));
vi.mock('../../notification-recipients', () => ({ resolveClientWarningRecipientsTx: vi.fn() }));
vi.mock('../../tcms/systemakteur', () => ({ beanspruche: vi.fn() }));
vi.mock('@taxtronik/db/staff-client-access', () => ({ canStaffAccessClientTx: vi.fn() }));
vi.mock('@taxtronik/mail/outbox', () => ({ enqueueDirectMailTx: vi.fn() }));

import { NACHRICHT_UNZUSTELLBAR_GRUENDE } from '@taxtronik/tcms-client';
import { meldegrund, TCMS_MELDEGRUND, TCMS_ZUSTELL_GRUENDE } from '../tcms-nachrichten';

describe('Meldegrund „unzustellbar“', () => {
  it('bildet jeden eigenen Grund auf einen Grund des Vertrags ab', () => {
    expect(Object.keys(TCMS_MELDEGRUND).sort()).toEqual(Object.keys(TCMS_ZUSTELL_GRUENDE).sort());
    for (const wert of Object.values(TCMS_MELDEGRUND)) {
      expect(NACHRICHT_UNZUSTELLBAR_GRUENDE).toContain(wert);
    }
  });

  it('feste Zuordnung je Fallgruppe', () => {
    expect(meldegrund('ABGELAUFEN')).toBe('ABGELAUFEN');
    expect(meldegrund('KONTAKT_UNBESTAETIGT')).toBe('KEIN_PORTALZUGANG');
    expect(meldegrund('KONTAKT_INAKTIV')).toBe('KEIN_PORTALZUGANG');
    expect(meldegrund('KONTAKT_OHNE_EMAIL')).toBe('KEIN_PORTALZUGANG');
    expect(meldegrund('KONTAKT_ANDERER_MANDANT')).toBe('EMPFAENGER_UNGUELTIG');
    expect(meldegrund('KONTAKT_UNBEKANNT')).toBe('EMPFAENGER_UNGUELTIG');
    expect(meldegrund('PERSON_OHNE_ZUGRIFF')).toBe('EMPFAENGER_UNGUELTIG');
    expect(meldegrund('MANDANT_INAKTIV')).toBe('SONSTIGES');
  });

  it('unbekannte Werte und Prototyp-Schlüssel werden SONSTIGES', () => {
    for (const wert of [null, '', 'unbekannt', 'toString', '__proto__', 'constructor']) {
      expect(meldegrund(wert)).toBe('SONSTIGES');
    }
  });
});
