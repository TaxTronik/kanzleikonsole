// TCMS s8 (Altbestand des Geschäftsprofils): Prüfpfade werden zu Bezeichnungen
// des Formulars; Fehler ohne Profilfrage ergeben einmal die allgemeine Meldung.
import { describe, expect, it, vi } from 'vitest';

// Die Formulare der Einrichtung binden ihre Server-Aktion nur; hier zählt die Beschriftung.
vi.mock('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions', () => ({
  einrichtungSpeichernAction: vi.fn(),
}));
import {
  PROFIL_FEHLER_ALLGEMEIN,
  profilFehlerZeilen,
  profilFeldBezeichnung,
} from '../profil-fehler';

describe('profilFeldBezeichnung', () => {
  it('Frage und Feld, Listeneinträge ab 1 gezählt, mit oder ohne Präfix der Einrichtung', () => {
    expect(profilFeldBezeichnung('p1.shopSystem')).toBe('P1 Verkaufskanäle · Shopsystem');
    expect(profilFeldBezeichnung('profil.p1.marktplaetze.0')).toBe(
      'P1 Verkaufskanäle · Marktplatz 1',
    );
    expect(profilFeldBezeichnung('p4.warengruppen.2.name')).toBe(
      'P4 Sortiment und Steuersätze · Warengruppe 3',
    );
    expect(profilFeldBezeichnung('p8.systeme.0.version')).toBe(
      'P8 Systemlandschaft · System 1: Version',
    );
    expect(profilFeldBezeichnung('p2.lager.1.land')).toBe(
      'P2 Fulfillment und Lagerorte · Lager 2: Land',
    );
  });

  it('unbekanntes Feld einer Frage: nur die Frage; kein Profilpfad: null', () => {
    expect(profilFeldBezeichnung('p7.neu')).toBe('P7 Gutscheine, Abos, Bundles');
    expect(profilFeldBezeichnung('')).toBeNull();
    expect(profilFeldBezeichnung('mandantId')).toBeNull();
    expect(profilFeldBezeichnung('profil')).toBeNull();
    expect(profilFeldBezeichnung('p13.x')).toBeNull();
  });
});

describe('profilFehlerZeilen', () => {
  it('Zeilen „Bezeichnung: Meldung“; ohne Profilfrage einmal die allgemeine Meldung', () => {
    expect(
      profilFehlerZeilen({
        'p1.shopSystem': ['Unzulässige Zeichen'],
        'p6.zahlungswege.1': ['Unzulässige Zeichen'],
        '': ['Unbekanntes Feld'],
        form: ['Unbekanntes Feld'],
      }),
    ).toEqual({
      zeilen: [
        'P1 Verkaufskanäle · Shopsystem: Unzulässige Zeichen',
        'P6 Zahlungswege · Zahlungsweg 2: Unzulässige Zeichen',
        PROFIL_FEHLER_ALLGEMEIN,
      ],
      feldbezogen: true,
    });
    expect(profilFehlerZeilen({ form: ['x'] })).toEqual({
      zeilen: [PROFIL_FEHLER_ALLGEMEIN],
      feldbezogen: false,
    });
    expect(profilFehlerZeilen({})).toEqual({
      zeilen: [PROFIL_FEHLER_ALLGEMEIN],
      feldbezogen: false,
    });
  });
});

describe('Einrichtung, Schritt 2', () => {
  it('Feldfehler des Profils mit Frage und Feld beschriftet', async () => {
    const { beschriftet, PROFIL_LABELS } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/schritte');
    expect(
      beschriftet(
        { 'profil.p1.shopSystem': ['Unzulässige Zeichen'], 'profil.p12': ['Ungültig'] },
        PROFIL_LABELS,
      ),
    ).toEqual({
      'profil.p1.shopSystem': ['P1 Verkaufskanäle · Shopsystem: Unzulässige Zeichen'],
      'profil.p12': ['P12 Organisation: Ungültig'],
    });
  });
});
