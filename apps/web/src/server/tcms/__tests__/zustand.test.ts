// TCMS Stufe 3: Abbildung der TCMS-Fehler auf Seiten- und Aktionszustände.
// Jede Abbildung hat einen Fall; Texte des Dienstes erreichen weder die
// Oberfläche noch das Log.
// Fachkatalog: TCMS-DIENST-001, TCMS-AKTEUR-001
import { describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/server/logger', () => ({ log }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import {
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
} from '@taxtronik/tcms-client';
import { TcmsAkteurVerweigert } from '../akteur';
import { TcmsInaktivError } from '../dienst';
import { TcmsPersonUnzulaessig } from '../personen';
import {
  TCMS_AKTION_TEXTE,
  TCMS_KEIN_RECHT,
  TCMS_SEITEN_TEXTE,
  aktionsFehlerAus,
  protokolliereTcmsFehler,
  seitenZustandAus,
  tcmsLogFelder,
} from '../zustand';

const GEHEIM = 'Vier-Augen: Anna Roth hat beantragt (Mandant Talwind GmbH)';
const details = {
  status: 403,
  code: 'NICHT_BERECHTIGT' as const,
  requestId: 'req-1',
  meldung: GEHEIM,
};

describe('seitenZustandAus', () => {
  it('bildet jede Fehlerart auf genau einen Zustand ab', () => {
    expect(seitenZustandAus(new TcmsInaktivError())).toEqual({ art: 'NICHT_KONFIGURIERT' });
    expect(seitenZustandAus(new TcmsAkteurVerweigert('KEIN_MANDANTENZUGRIFF'))).toEqual({
      art: 'KEIN_ZUGRIFF',
      neuAnmelden: false,
    });
    expect(seitenZustandAus(new TcmsAkteurVerweigert('SITZUNG_VERALTET'))).toEqual({
      art: 'KEIN_ZUGRIFF',
      neuAnmelden: true,
    });
    expect(seitenZustandAus(new TcmsNichtBerechtigt(details))).toEqual({
      art: 'KEIN_ZUGRIFF',
      neuAnmelden: false,
    });
    expect(seitenZustandAus(new TcmsNichtGefunden({ status: 404 }))).toBe('NICHT_GEFUNDEN');
    for (const fehler of [
      new TcmsNichtVerfuegbar('ZEITLIMIT', { requestId: 'req-2' }),
      new TcmsProtokollFehler('SCHEMA', { status: 200, requestId: 'req-2' }),
      new TcmsNichtAuthentifiziert({ status: 401, requestId: 'req-2' }),
    ]) {
      expect(seitenZustandAus(fehler)).toEqual({ art: 'NICHT_ERREICHBAR', requestId: 'req-2' });
    }
    for (const fehler of [
      new TcmsUngueltig({ stand: ['x'] }, { status: 400, requestId: 'req-3' }),
      new TcmsKonflikt({ status: 409, requestId: 'req-3' }),
    ]) {
      expect(seitenZustandAus(fehler)).toEqual({ art: 'ANFRAGE_UNGUELTIG', requestId: 'req-3' });
    }
  });

  it('verschluckt keine fremden Fehler und zeigt keine fremd geformte requestId', () => {
    expect(seitenZustandAus(new Error('DB weg'))).toBeNull();
    expect(seitenZustandAus('x')).toBeNull();
    const fehler = new TcmsNichtVerfuegbar('STATUS', { status: 503, requestId: '<script>' });
    expect(seitenZustandAus(fehler)).toEqual({ art: 'NICHT_ERREICHBAR', requestId: null });
  });

  it('hat für jeden Zustand einen festen Titel und Text', () => {
    for (const art of [
      'NICHT_KONFIGURIERT',
      'KEIN_ZUGRIFF',
      'NICHT_ERREICHBAR',
      'ANFRAGE_UNGUELTIG',
    ] as const) {
      expect(TCMS_SEITEN_TEXTE[art].titel.length).toBeGreaterThan(0);
      expect(TCMS_SEITEN_TEXTE[art].text.length).toBeGreaterThan(0);
    }
    expect(TCMS_SEITEN_TEXTE.NICHT_ERREICHBAR.titel).toBe('Tax-CMS derzeit nicht erreichbar');
  });
});

describe('aktionsFehlerAus', () => {
  const schreibend = { schreibend: true };

  it('403: feste Meldung je Schlüssel, nie der Text des Dienstes', () => {
    const fehler = new TcmsNichtBerechtigt(details);
    expect(aktionsFehlerAus(fehler, { ...schreibend, keinRecht: 'VIER_AUGEN' })).toEqual({
      ok: false,
      error: TCMS_KEIN_RECHT.VIER_AUGEN,
      errorCode: 'FORBIDDEN',
    });
    expect(aktionsFehlerAus(fehler, schreibend)?.error).toBe(TCMS_KEIN_RECHT.STANDARD);
    expect(JSON.stringify(aktionsFehlerAus(fehler, schreibend))).not.toContain('Anna');
  });

  it('409: „Wurde zwischenzeitlich geändert – bitte neu laden“', () => {
    expect(aktionsFehlerAus(new TcmsKonflikt({ status: 409 }), schreibend)).toEqual({
      ok: false,
      error: 'Wurde zwischenzeitlich geändert – bitte neu laden.',
      errorCode: 'CONFLICT',
    });
  });

  it('400: Feldfehler mit deutschem Standardtext unter dem Formularfeld', () => {
    const fehler = new TcmsUngueltig(
      { funktion: ['Too big: expected string to have <=200 characters'], 'rollen.1': ['x'] },
      { status: 400 },
    );
    expect(aktionsFehlerAus(fehler, schreibend)).toEqual({
      ok: false,
      error: TCMS_AKTION_TEXTE.ungueltig,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { funktion: [TCMS_AKTION_TEXTE.feld], rollen: [TCMS_AKTION_TEXTE.feld] },
    });
    // Lokal abgewiesen (nicht gesendet): Präfix body./query. fällt weg.
    const lokal = new TcmsUngueltig({ 'body.kontaktId': ['Invalid UUID'] }, { lokal: true });
    expect(aktionsFehlerAus(lokal, { ...schreibend, felder: { kontaktId: 'kontakt' } })).toEqual({
      ok: false,
      error: TCMS_AKTION_TEXTE.ungueltig,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { kontakt: [TCMS_AKTION_TEXTE.feld] },
    });
  });

  it('400: mit Zuordnung nur zugeordnete Felder, ohne Prototyp-Schlüssel', () => {
    const fehler = new TcmsUngueltig(
      { __proto__x: ['a'], constructor: ['b'], 'body.unbekannt': ['c'], 'a b': ['d'] },
      { status: 400 },
    );
    const ergebnis = aktionsFehlerAus(fehler, { ...schreibend, felder: { funktion: 'funktion' } });
    expect(ergebnis).toEqual({
      ok: false,
      error: TCMS_AKTION_TEXTE.ungueltig,
      errorCode: 'VALIDATION_ERROR',
    });
    const ohne = aktionsFehlerAus(
      new TcmsUngueltig({ constructor: ['b'] }, { status: 400 }),
      schreibend,
    );
    expect(ohne?.fieldErrors).toBeUndefined();
  });

  it('Ausfall: feste Meldung; bei Schreibzugriffen ohne verlässliche Antwort „Ausgang offen“', () => {
    const nicht = TCMS_AKTION_TEXTE.nichtErreichbar;
    const unklar = TCMS_AKTION_TEXTE.unklar;
    const faelle: Array<[Error, string, string]> = [
      [new TcmsNichtVerfuegbar('BREAKER'), nicht, nicht],
      [new TcmsNichtVerfuegbar('STATUS', { status: 503 }), nicht, nicht],
      [new TcmsNichtAuthentifiziert({ status: 401 }), nicht, nicht],
      [new TcmsNichtVerfuegbar('ZEITLIMIT'), unklar, nicht],
      [new TcmsNichtVerfuegbar('TRANSPORT'), unklar, nicht],
      [new TcmsProtokollFehler('SCHEMA', { status: 200 }), unklar, nicht],
    ];
    for (const [fehler, beimSchreiben, beimLesen] of faelle) {
      expect(aktionsFehlerAus(fehler, { schreibend: true })).toEqual({
        ok: false,
        error: beimSchreiben,
        errorCode: 'INTERNAL_ERROR',
      });
      expect(aktionsFehlerAus(fehler, { schreibend: false })?.error).toBe(beimLesen);
    }
  });

  it('Verweigerung, inaktives Modul, 404 und unzulässige Personen', () => {
    expect(aktionsFehlerAus(new TcmsAkteurVerweigert('KEIN_MANDANTENZUGRIFF'), schreibend)).toEqual(
      {
        ok: false,
        error: 'Kein Zugriff auf das Tax-CMS.',
        errorCode: 'FORBIDDEN',
      },
    );
    expect(aktionsFehlerAus(new TcmsAkteurVerweigert('SITZUNG_ABGELAUFEN'), schreibend)).toEqual({
      ok: false,
      error: TCMS_AKTION_TEXTE.neuAnmelden,
      errorCode: 'UNAUTHORIZED',
    });
    expect(aktionsFehlerAus(new TcmsInaktivError(), schreibend)?.error).toBe(
      'Das Tax-CMS ist für diese Kanzlei nicht aktiv.',
    );
    expect(aktionsFehlerAus(new TcmsNichtGefunden({ status: 404 }), schreibend)).toEqual({
      ok: false,
      error: TCMS_AKTION_TEXTE.nichtGefunden,
      errorCode: 'NOT_FOUND',
    });
    const person = new TcmsPersonUnzulaessig('KONTAKT', 'kontaktId');
    expect(aktionsFehlerAus(person, schreibend)).toEqual({
      ok: false,
      error: person.message,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { kontaktId: [person.message] },
    });
    expect(aktionsFehlerAus(new Error('x'), schreibend)).toBeUndefined();
  });
});

describe('Protokoll', () => {
  it('enthält Klassifikation und requestId, nie Meldung, Grundtext oder Feldwerte', () => {
    const fehler = new TcmsNichtBerechtigt(details);
    expect(tcmsLogFelder(fehler)).toEqual({
      fehler: 'TcmsNichtBerechtigt',
      status: 403,
      code: 'NICHT_BERECHTIGT',
      tcmsRequestId: 'req-1',
    });
    protokolliereTcmsFehler(
      { komponente: 'tcms-aktion', endpunkt: 'durchfuehrungGegenzeichnen' },
      fehler,
    );
    protokolliereTcmsFehler(
      { komponente: 'tcms-seite', endpunkt: 'kontextLesen' },
      new TcmsNichtVerfuegbar('ZEITLIMIT', { requestId: 'req-9' }),
    );
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
    const zeilen = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(zeilen).not.toContain('Anna');
    expect(zeilen).not.toContain('Talwind');
    expect(zeilen).toContain('durchfuehrungGegenzeichnen');
    expect(tcmsLogFelder(new TcmsUngueltig({ x: ['Wert 12345'] }, { lokal: true }))).toEqual({
      fehler: 'TcmsUngueltig',
      status: null,
      code: null,
      tcmsRequestId: null,
      lokal: 1,
    });
    expect(tcmsLogFelder(new TcmsAkteurVerweigert('PERSON_INAKTIV'))).toEqual({
      fehler: 'TcmsAkteurVerweigert',
      grund: 'PERSON_INAKTIV',
    });
  });
});
