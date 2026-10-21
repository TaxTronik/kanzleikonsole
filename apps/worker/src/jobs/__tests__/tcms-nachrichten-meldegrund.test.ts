// =============================================================================
// TCMS Stufe 3 (Integration, TCMS s6): Grund der Meldung „unzustellbar“ an das
// Tax-CMS. Die Abbildung der eigenen Gründe ist vollständig, nutzt nur Gründe
// des Vertrags und ist fest; unbekannte Werte (Drift der Datenbank) und
// Prototyp-Schlüssel werden zu SONSTIGES, nie zu einem Fehler oder Freitext.
// Den Ablauf (Grund vor dem Senden, Wiederholung mit demselben Grund, 409 =
// erledigt) belegt tcms-nachrichten-db.test.ts.
// kk-tcms-s11: Abschluss einer eingeplanten Mail aus dem Endstatus ihres
// Versandauftrags – zugestellt nur bei PROVIDER_ACCEPTED, jeder andere
// Endstatus und ein fehlender Auftrag gescheitert (fail closed), verworfene
// Aufträge mit dem Grund ihrer Aktualitätsprüfung.
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
vi.mock('@taxtronik/mail/outbox', async (original) => ({
  // Echte Aktualitätsprüfung (Texte, Vermerk); nur das Einplanen entfällt.
  ...(await original<typeof import('@taxtronik/mail/outbox')>()),
  enqueueDirectMailTx: vi.fn(),
}));

import type { MailOutboxStatus } from '@prisma/client';
import { NACHRICHT_UNZUSTELLBAR_GRUENDE } from '@taxtronik/tcms-client';
import { mailOutboxSkipVermerk, TCMS_VERWORFEN_TEXTE } from '@taxtronik/mail/outbox';
import {
  auftragsAbschluss,
  meldegrund,
  meldungAus,
  TCMS_MELDEGRUND,
  TCMS_ZUSTELL_GRUENDE,
} from '../tcms-nachrichten';

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
    for (const versand of [
      'VERSAND_GESCHEITERT',
      'VERSAND_UNKLAR',
      'VERSAND_VERWORFEN',
      'AUFTRAG_FEHLT',
    ]) {
      expect(meldegrund(versand), versand).toBe('SONSTIGES');
    }
  });

  it('unbekannte Werte und Prototyp-Schlüssel werden SONSTIGES', () => {
    for (const wert of [null, '', 'unbekannt', 'toString', '__proto__', 'constructor']) {
      expect(meldegrund(wert)).toBe('SONSTIGES');
    }
  });
});

describe('kk-tcms-s11: Abschluss aus dem Versandauftrag', () => {
  const auftrag = (status: MailOutboxStatus, lastError: string | null = null) => ({
    status,
    lastError,
  });

  it('zugestellt nur nach der Annahme durch den Mailserver; solange der Versand läuft, offen', () => {
    for (const status of ['QUEUED', 'SENDING', 'RETRY_PENDING'] as const) {
      expect(auftragsAbschluss(auftrag(status)), status).toBeNull();
    }
    expect(auftragsAbschluss(auftrag('PROVIDER_ACCEPTED'))).toEqual({
      status: 'ANGENOMMEN',
      grund: null,
    });
  });

  it('jeder andere Endstatus und ein fehlender Auftrag sind gescheitert (fail closed)', () => {
    expect(auftragsAbschluss(auftrag('FAILED'))).toEqual({
      status: 'GESCHEITERT',
      grund: 'VERSAND_GESCHEITERT',
    });
    expect(auftragsAbschluss(auftrag('NO_RECIPIENT'))?.grund).toBe('VERSAND_GESCHEITERT');
    expect(auftragsAbschluss(auftrag('PARTIAL_FAILURE'))?.grund).toBe('VERSAND_GESCHEITERT');
    expect(auftragsAbschluss(auftrag('UNKNOWN'))?.grund).toBe('VERSAND_UNKLAR');
    expect(auftragsAbschluss(null)).toEqual({ status: 'GESCHEITERT', grund: 'AUFTRAG_FEHLT' });
    // Drift: ein unbekannter Status ist nie „zugestellt“.
    expect(auftragsAbschluss(auftrag('NEU' as MailOutboxStatus))?.grund).toBe('VERSAND_UNKLAR');
  });

  it('ein verworfener Auftrag meldet den Grund seiner Aktualitätsprüfung', () => {
    const verworfen = (text: string) =>
      auftragsAbschluss(auftrag('SKIPPED', mailOutboxSkipVermerk(text)));
    const t = TCMS_VERWORFEN_TEXTE;
    const erwartet: Array<[string, string, string]> = [
      [t.ABGELAUFEN, 'ABGELAUFEN', 'ABGELAUFEN'],
      [t.EMPFAENGER_FREMD, 'KONTAKT_ANDERER_MANDANT', 'EMPFAENGER_UNGUELTIG'],
      [t.EMPFAENGER_INAKTIV, 'KONTAKT_INAKTIV', 'KEIN_PORTALZUGANG'],
      [t.ADRESSE_UNBESTAETIGT, 'KONTAKT_UNBESTAETIGT', 'KEIN_PORTALZUGANG'],
      [t.MANDAT_INAKTIV, 'MANDANT_INAKTIV', 'SONSTIGES'],
      [t.MANDANT_ANONYMISIERT, 'MANDANT_INAKTIV', 'SONSTIGES'],
      [t.MANDANT_FEHLT, 'MANDANT_UNBEKANNT', 'SONSTIGES'],
      [t.ADRESSE_GEAENDERT, 'VERSAND_VERWORFEN', 'SONSTIGES'],
      [t.EMPFAENGER_UNBESTIMMT, 'VERSAND_VERWORFEN', 'SONSTIGES'],
      [t.OHNE_ENDE, 'VERSAND_VERWORFEN', 'SONSTIGES'],
      [t.FREMDER_VORGANG, 'VERSAND_VERWORFEN', 'SONSTIGES'],
      ['Ein anderer Grund.', 'VERSAND_VERWORFEN', 'SONSTIGES'],
    ];
    for (const [text, grund, gemeldet] of erwartet) {
      const abschluss = verworfen(text);
      expect(abschluss, text).toEqual({ status: 'GESCHEITERT', grund });
      expect(meldungAus(abschluss!), text).toEqual({ art: 'UNZUSTELLBAR', grund: gemeldet });
    }
    // Ohne den Vermerk der Outbox (oder ohne last_error) ebenso fail closed.
    expect(auftragsAbschluss(auftrag('SKIPPED', t.ABGELAUFEN))?.grund).toBe('VERSAND_VERWORFEN');
    expect(auftragsAbschluss(auftrag('SKIPPED'))?.grund).toBe('VERSAND_VERWORFEN');
  });

  it('Meldung je Status: angenommen = zugestellt, gescheitert/unzustellbar mit Grund, offen ohne', () => {
    expect(meldungAus({ status: 'ANGENOMMEN', grund: null })).toEqual({ art: 'ZUGESTELLT' });
    expect(meldungAus({ status: 'GESCHEITERT', grund: 'VERSAND_GESCHEITERT' })).toEqual({
      art: 'UNZUSTELLBAR',
      grund: 'SONSTIGES',
    });
    expect(meldungAus({ status: 'UNZUSTELLBAR', grund: 'KONTAKT_INAKTIV' })).toEqual({
      art: 'UNZUSTELLBAR',
      grund: 'KEIN_PORTALZUGANG',
    });
    for (const status of ['EINGEPLANT', 'ZURUECKGESTELLT', 'UNBEKANNT']) {
      expect(meldungAus({ status, grund: null }), status).toBeNull();
    }
  });
});
