// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: Bausteine der Oberflächen „Programm &
// Dokumentation“ – Bestätigungsdialog und Ein-Klick-Aktion (erst bestätigen,
// dann senden; Fehler bleiben sichtbar; kein Doppelaufruf), Bausteine der
// CMS-Beschreibung (lebend: Namen der kanzleikonsole, eingefroren: eingefrorene
// Namen), Auswahl von Kontakten (nur bekannte Kontakte dieses Mandanten).
// Fachkatalog: TCMS-DIENST-001
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BausteinSatzDaten } from '@taxtronik/tcms-contract';
import { BausteinBlock, type BausteinQuelle } from '../beschreibung';
import { TcmsAktionsDialog, type TcmsAktionsErgebnis } from '../dialog';
import { codeText } from '../freigaben';
import { TcmsKnopfAktion } from '../knopf';
import { ansprechpersonen, kontaktPersonen, rollenText, type KontaktRolle } from '../kontakte';

const A = 'b1000000-0000-4000-8000-000000000001';
const J = 'b1000000-0000-4000-8000-000000000011';
const M = 'b1000000-0000-4000-8000-000000000012';
const X = 'b1000000-0000-4000-8000-0000000000ff';

function verzoegert() {
  let loesen!: (r: TcmsAktionsErgebnis) => void;
  const aktion = vi.fn(
    (_v: TcmsAktionsErgebnis | null, _fd: FormData) =>
      new Promise<TcmsAktionsErgebnis>((r) => {
        loesen = r;
      }),
  );
  return { aktion, loesen: (r: TcmsAktionsErgebnis) => act(async () => loesen(r)) };
}

describe('TcmsAktionsDialog', () => {
  function dialog(aktion: ReturnType<typeof verzoegert>['aktion'], extra = {}) {
    return render(
      <TcmsAktionsDialog
        ausloeser="Neu adressieren"
        titel="Anforderung neu adressieren"
        beschreibung={<p>Ein ausgestellter Code verfällt.</p>}
        bestaetigen="Bestätigen"
        gefahr
        aktion={aktion}
        versteckt={{ freigabeId: 'f-1' }}
        erfolg="Erledigt."
        fieldIds={{ empfaengerId: 'empf' }}
        {...extra}
      >
        <label htmlFor="empf">Empfänger</label>
        <select id="empf" name="empfaengerId" defaultValue="">
          <option value="">Bitte wählen …</option>
          <option value={J}>Jana Weller</option>
        </select>
      </TcmsAktionsDialog>,
    );
  }

  it('ruft die Aktion erst nach Bestätigung, mit festen Werten und Auswahl', async () => {
    const { aktion, loesen } = verzoegert();
    dialog(aktion);
    fireEvent.click(screen.getByRole('button', { name: 'Neu adressieren' }));
    expect(aktion).not.toHaveBeenCalled();
    const d = screen.getByRole('dialog');
    expect(d.textContent).toContain('Ein ausgestellter Code verfällt.');
    fireEvent.change(within(d).getByRole('combobox', { name: 'Empfänger' }), {
      target: { value: J },
    });
    const senden = within(d).getByRole('button', { name: 'Bestätigen' });
    expect(senden.className).toContain('bg-red-600');
    fireEvent.click(senden);
    // Zweiter Klick während der Übertragung: kein zweiter Aufruf.
    fireEvent.submit(senden.closest('form')!);
    expect(aktion).toHaveBeenCalledTimes(1);
    const fd = aktion.mock.calls[0]![1];
    expect(Object.fromEntries(fd.entries())).toEqual({ freigabeId: 'f-1', empfaengerId: J });
    await loesen({ ok: true, meldung: 'An Jana Weller adressiert.' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('An Jana Weller adressiert.');
  });

  it('Ablehnung bleibt im Dialog sichtbar, Eingaben bleiben stehen', async () => {
    const { aktion, loesen } = verzoegert();
    dialog(aktion);
    fireEvent.click(screen.getByRole('button', { name: 'Neu adressieren' }));
    const d = screen.getByRole('dialog');
    fireEvent.change(within(d).getByRole('combobox'), { target: { value: J } });
    fireEvent.click(within(d).getByRole('button', { name: 'Bestätigen' }));
    await loesen({
      ok: false,
      error: 'Diese Person ist kein Kontakt dieses Mandanten.',
      fieldErrors: { empfaengerId: ['Bitte wählen Sie eine Person dieses Mandanten.'] },
    });
    const offen = screen.getByRole('dialog');
    const fehler = within(offen).getByRole('alert');
    expect(fehler.textContent).toContain('Das hat nicht geklappt.');
    // Feldfehler mit Sprungmarke zum Feld (die Sammelmeldung tritt dahinter zurück).
    expect(
      within(fehler)
        .getByRole('link', { name: 'Bitte wählen Sie eine Person dieses Mandanten.' })
        .getAttribute('href'),
    ).toBe('#empf');
    expect((within(offen).getByRole('combobox') as HTMLSelectElement).value).toBe(J);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Abbrechen sendet nichts; gesperrt mit sichtbarem Grund', () => {
    const { aktion } = verzoegert();
    const { unmount } = dialog(aktion);
    fireEvent.click(screen.getByRole('button', { name: 'Neu adressieren' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(aktion).not.toHaveBeenCalled();
    unmount();

    dialog(aktion, { deaktiviert: true, deaktiviertGrund: 'Keine gesetzliche Vertretung.' });
    const knopf = screen.getByRole('button', { name: 'Neu adressieren' });
    expect(knopf).toHaveProperty('disabled', true);
    expect(document.getElementById(knopf.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Keine gesetzliche Vertretung.',
    );
  });
});

describe('TcmsKnopfAktion', () => {
  it('ein Aufruf je Klickfolge; Fehler als Alarm, Erfolg als Status', async () => {
    const { aktion, loesen } = verzoegert();
    render(
      <TcmsKnopfAktion aktion={aktion} versteckt={{ versionId: 'v-1' }} erfolg="Eingereicht.">
        Einreichen
      </TcmsKnopfAktion>,
    );
    const knopf = screen.getByRole('button', { name: 'Einreichen' });
    fireEvent.click(knopf);
    fireEvent.submit(knopf.closest('form')!);
    expect(aktion).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(aktion.mock.calls[0]![1].entries())).toEqual({ versionId: 'v-1' });
    await loesen({ ok: false, error: 'Nur Entwürfe lassen sich einreichen.' });
    expect(screen.getByRole('alert').textContent).toBe('Nur Entwürfe lassen sich einreichen.');

    fireEvent.click(screen.getByRole('button', { name: 'Einreichen' }));
    await loesen({ ok: true });
    expect(screen.getByRole('status').textContent).toBe('Eingereicht.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gesperrt: kein Aufruf, Grund sichtbar und verknüpft', () => {
    const aktion = vi.fn();
    render(
      <TcmsKnopfAktion aktion={aktion} erfolg="x" deaktiviert deaktiviertGrund="Kein Recht.">
        Aufnehmen
      </TcmsKnopfAktion>,
    );
    const knopf = screen.getByRole('button', { name: 'Aufnehmen' });
    fireEvent.submit(knopf.closest('form')!);
    expect(aktion).not.toHaveBeenCalled();
    expect(document.getElementById(knopf.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Kein Recht.',
    );
  });
});

describe('BausteinBlock VERANTWORTUNG', () => {
  const satz = {
    VERANTWORTUNG: {
      rollen: [
        { rolle: 'Gesetzliche Vertretung', name: 'Jana (eingefroren)', personId: J },
        { rolle: 'Tax-Compliance-Beauftragte:r', name: '—', personId: X },
      ],
      kontrollen: [
        {
          code: 'K-EC-02',
          titel: 'Review',
          partei: 'MANDANT',
          durchfuehrend: 'Murat (eingefroren)',
          vertretung: '—',
          gegenzeichnung: 'Jana (eingefroren) (Mandant)',
          durchfuehrendId: M,
          vertretungId: null,
          gegenzeichnungId: J,
        },
      ],
    },
  } as unknown as BausteinSatzDaten;

  it('lebend: Namen der kanzleikonsole, unbekannte ID als „Unbekannte Person“', () => {
    const quelle: BausteinQuelle = {
      modus: 'live',
      stand: '2026-10-19',
      satz,
      namen: { [J]: 'Jana Weller', [M]: 'Murat Yilmaz' },
    };
    const { container } = render(<BausteinBlock art="VERANTWORTUNG" quelle={quelle} />);
    const text = container.textContent!;
    expect(text).toContain('Gesetzliche Vertretung: Jana Weller');
    expect(text).toContain('Tax-Compliance-Beauftragte:r: Unbekannte Person');
    expect(text).toContain('Murat Yilmaz');
    expect(text).toContain('Jana Weller (Mandant)');
    expect(text).not.toContain('eingefroren)');
    expect(text).toContain('automatisch · Stand 19.10.2026');
  });

  it('eingefroren: genau die eingefrorenen Namen, keine Auflösung', () => {
    const quelle: BausteinQuelle = { modus: 'snapshot', stand: '2026-09-30', satz };
    const { container } = render(<BausteinBlock art="VERANTWORTUNG" quelle={quelle} />);
    const text = container.textContent!;
    expect(text).toContain('Gesetzliche Vertretung: Jana (eingefroren)');
    expect(text).toContain('Murat (eingefroren)');
    expect(text).toContain('Jana (eingefroren) (Mandant)');
    expect(text).not.toContain('Jana Weller');
    expect(text).toContain('eingefroren · Stand 30.09.2026');
  });
});

describe('Kontakte und Freigaben', () => {
  const rollen: KontaktRolle[] = [
    { kontaktId: J, rolle: 'GESETZLICHER_VERTRETER', funktion: 'Geschäftsführerin' },
    { kontaktId: J, rolle: 'MITARBEITER', funktion: null },
    { kontaktId: M, rolle: 'TAX_COMPLIANCE_BEAUFTRAGTER', funktion: null },
    { kontaktId: X, rolle: 'GESETZLICHER_VERTRETER', funktion: null },
  ];
  const namen = {
    name: (id: string | null) =>
      ({ [J]: 'Jana Weller', [M]: 'Anton Murat', [A]: 'Anna' })[id ?? ''] ?? 'Unbekannte Person',
    bekannt: (id: string | null) => id === J || id === M || id === A,
  };

  it('nur bekannte Kontakte (Namen der kanzleikonsole), ohne Dubletten, nach Name', () => {
    expect(kontaktPersonen(rollen, namen)).toEqual([
      { id: M, name: 'Anton Murat' },
      { id: J, name: 'Jana Weller' },
    ]);
    expect(kontaktPersonen(rollen, namen, ['GESETZLICHER_VERTRETER'])).toEqual([
      { id: J, name: 'Jana Weller' },
    ]);
    expect(ansprechpersonen(rollen, namen).map((p) => p.id)).toEqual([J, M]);
    expect(rollenText(rollen, J.toUpperCase())).toBe('Gesetzliche Vertretung, Mitarbeitende');
    expect(rollenText(rollen, A)).toBeNull();
  });

  it('Codezustand ohne den Code selbst; Kenntnisnahme ohne Code', () => {
    const d = (iso: string | null) => `D(${iso})`;
    expect(
      codeText({ art: 'BESCHREIBUNG', codeStatus: 'AKTIV', codeAblauf: '2026-10-20' }, d),
    ).toBe('Code gültig bis D(2026-10-20)');
    expect(codeText({ art: 'KENNTNISNAHME', codeStatus: 'AKTIV', codeAblauf: null }, d)).toBe(
      'ohne Code',
    );
    expect(codeText({ art: 'ZIELE', codeStatus: 'GESPERRT', codeAblauf: null }, d)).toContain(
      'gesperrt',
    );
  });
});
