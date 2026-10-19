// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Client-Bausteine der Aktionen (Begründungsdialog,
// Aktionsknopf). Geprüft wird, was an die Server Action geht (verborgene
// Felder, Begründung), dass Eingaben bei Fehlern stehen bleiben, Fehler als
// Zusammenfassung und am Feld erscheinen, eine laufende Übermittlung nicht
// wiederholt wird und gesperrte Bedienelemente nichts auslösen.
// Fachkatalog: TCMS-DIENST-001
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MIN_BEGRUENDUNG } from '@taxtronik/tcms-domain';
import { describe, expect, it, vi } from 'vitest';
import { AktionsKnopf, BegruendungsDialog } from '../aktion';
import type { TcmsAktionsErgebnis } from '../ergebnis';

type Aktion = (vorher: TcmsAktionsErgebnis | null, fd: FormData) => Promise<TcmsAktionsErgebnis>;

const BEGRUENDUNG = 'Die Datenlage hat sich seit dem letzten Stand deutlich geändert.';

function felderAus(fd: FormData) {
  return [...fd.entries()].map(([k, v]) => [k, String(v)]);
}

function deferred() {
  let resolve!: (e: TcmsAktionsErgebnis) => void;
  const promise = new Promise<TcmsAktionsErgebnis>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('BegruendungsDialog', () => {
  function dialog(aktion: Aktion, extra: Partial<Parameters<typeof BegruendungsDialog>[0]> = {}) {
    render(
      <BegruendungsDialog
        ausloeser="Neu bewerten …"
        titel="EC-UST-01 neu bewerten"
        aktion={aktion}
        felder={{ risikoId: 'EC-UST-01', standId: 'st_1' }}
        bestaetigen="Speichern"
        {...extra}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Neu bewerten …' }));
    const d = screen.getByRole('dialog', { name: 'EC-UST-01 neu bewerten' });
    return { d, feld: within(d).getByLabelText('Begründung') as HTMLTextAreaElement };
  }

  it('Pflichtbegründung mit Grenzen des Vertrags und Vier-Augen-Hinweis', () => {
    const { d, feld } = dialog(vi.fn());
    expect(feld.required).toBe(true);
    expect(feld.minLength).toBe(MIN_BEGRUENDUNG);
    expect(feld.maxLength).toBe(2000);
    const hinweis = document.getElementById(feld.getAttribute('aria-describedby')!.split(' ')[0]!);
    expect(hinweis?.textContent).toContain(`Mindestens ${MIN_BEGRUENDUNG} Zeichen.`);
    expect(hinweis?.textContent).toContain('zweite Person');
    expect(within(d).getByRole('button', { name: 'Speichern' })).toBeTruthy();
  });

  it('sendet verborgene Felder und Begründung; Fehler bleiben im Dialog, Eingabe bleibt stehen', async () => {
    const aktion = vi
      .fn<Aktion>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Bitte prüfen Sie Ihre Angaben.',
        fieldErrors: { begruendung: ['Mindestens 30 Zeichen.'] },
      })
      .mockResolvedValueOnce({ ok: true, meldung: 'EC-UST-01 neu bewertet.' });
    const { d, feld } = dialog(aktion);
    fireEvent.change(feld, { target: { value: 'zu kurz' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(felderAus(aktion.mock.calls[0]![1])).toEqual([
      ['risikoId', 'EC-UST-01'],
      ['standId', 'st_1'],
      ['begruendung', 'zu kurz'],
    ]);
    expect(await within(d).findByRole('alert')).toBeTruthy();
    expect(feld.value).toBe('zu kurz');
    expect(feld.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(feld, { target: { value: BEGRUENDUNG } });
    fireEvent.click(within(d).getByRole('button', { name: 'Speichern' }));
    // Erfolg: Dialog zu, Meldung neben dem Auslöser.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('EC-UST-01 neu bewertet.');
    // Neue Öffnung beginnt leer.
    fireEvent.click(screen.getByRole('button', { name: 'Neu bewerten …' }));
    expect((screen.getByLabelText('Begründung') as HTMLTextAreaElement).value).toBe('');
  });

  it('gesperrt: Auslöser deaktiviert mit Grund, kein Dialog', () => {
    render(
      <BegruendungsDialog
        ausloeser="Zurückweisen …"
        titel="Zurückweisen"
        aktion={vi.fn()}
        gesperrt="Historischer Stand"
        vierAugen={false}
      />,
    );
    const knopf = screen.getByRole('button', { name: 'Zurückweisen …' }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toBe('Historischer Stand');
    fireEvent.click(knopf);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AktionsKnopf', () => {
  it('sendet nur die verborgenen Felder, zeigt Fehler und wiederholt keine laufende Übermittlung', async () => {
    const offen = deferred();
    const aktion = vi.fn<Aktion>(() => offen.promise);
    render(
      <AktionsKnopf
        aktion={aktion}
        felder={{ uebersteuerungId: 'ue_1', entscheidung: 'FREIGEBEN' }}
        beschriftung="Übersteuerung freigeben"
      />,
    );
    const knopf = screen.getByRole('button', { name: 'Übersteuerung freigeben' });
    fireEvent.click(knopf);
    fireEvent.submit(knopf.closest('form')!);
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(felderAus(aktion.mock.calls[0]![1])).toEqual([
      ['uebersteuerungId', 'ue_1'],
      ['entscheidung', 'FREIGEBEN'],
    ]);
    await act(async () =>
      offen.resolve({
        ok: false,
        error: 'Diese Entscheidung trifft eine zweite Person.',
        errorCode: 'FORBIDDEN',
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('zweite Person');
    expect(aktion).toHaveBeenCalledOnce();
  });

  it('gesperrt: deaktiviert mit Grund', () => {
    render(<AktionsKnopf aktion={vi.fn()} beschriftung="Freigeben" gesperrt="Kein Recht" />);
    const knopf = screen.getByRole('button', { name: 'Freigeben' }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toBe('Kein Recht');
  });
});
