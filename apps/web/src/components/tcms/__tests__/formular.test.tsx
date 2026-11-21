// @vitest-environment jsdom
// Integration TCMS Stufe 3: gemeinsamer Formular-Baustein aller Bereiche
// (components/tcms/formular.ts). Schutzregeln:
//   - Eingaben bleiben bei einer Ablehnung stehen (React 19 setzt sonst
//     unkontrollierte Felder nach jeder Übermittlung zurück);
//   - zurückgesetzt wird nur nach Erfolg und nur mit `zuruecksetzen`;
//   - keine Doppelübermittlung, solange eine läuft;
//   - mit Bestätigung erst nach ausdrücklicher Zustimmung im Gefahrendialog,
//     abhängig vom auslösenden Knopf;
//   - `nachLesen` läuft nach dem Lesen der Formulardaten (Code-Feld leeren).
// Dazu die Formulare der Bereiche C und 3a, die vorher Eingaben verloren.
// Fachkatalog: TCMS-DIENST-001
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { confirmDialog } from '@/components/ui/modal';
import { describe, expect, it, vi } from 'vitest';
import type { TcmsAktionsErgebnis } from '../ergebnis';
import { useTcmsFormular, type TcmsFormularOptionen } from '../formular';

const h = vi.hoisted(() => ({ bestaetigt: true, fragen: [] as unknown[] }));
vi.mock('@/components/ui/modal', async (original) => ({
  ...(await original<typeof import('@/components/ui/modal')>()),
  confirmDialog: vi.fn(async (text: unknown) => {
    h.fragen.push(text);
    return h.bestaetigt;
  }),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions', () => ({
  kontaktRollenSetzenAction: vi.fn(),
}));

vi.mock('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions', () => ({
  einrichtungSpeichernAction: vi.fn(),
}));

type Aktion = (vorher: TcmsAktionsErgebnis | null, fd: FormData) => Promise<TcmsAktionsErgebnis>;

function Formular({
  aktion,
  optionen,
  nachErfolg,
  antrag = 'alt',
}: {
  aktion: Aktion;
  optionen?: TcmsFormularOptionen;
  antrag?: string;
  nachErfolg?: (form: HTMLFormElement) => void;
}) {
  const { ergebnis, laeuft, formular } = useTcmsFormular(aktion, optionen);
  const { ref } = formular;
  useLayoutEffect(() => {
    if (ergebnis?.ok && !laeuft && ref.current) nachErfolg?.(ref.current);
  }, [ergebnis, laeuft, nachErfolg, ref]);
  return (
    <form {...formular} aria-label="Testformular">
      <input type="hidden" name="antrag" value={antrag} />
      <label htmlFor="titel">Titel</label>
      <input id="titel" name="titel" defaultValue="" />
      <label htmlFor="code">Code</label>
      <input id="code" name="code" defaultValue="" />
      <button type="submit" name="absicht" value="speichern">
        Speichern
      </button>
      <button type="submit" name="absicht" value="loeschen">
        Löschen
      </button>
      <p data-testid="stand">{laeuft ? 'läuft' : ergebnis ? String(ergebnis.ok) : 'leer'}</p>
    </form>
  );
}

function deferred<T = TcmsAktionsErgebnis>() {
  let resolve!: (e: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function feld(name: string) {
  return screen.getByLabelText(name) as HTMLInputElement;
}

describe('useTcmsFormular', () => {
  it('Ablehnung: Eingaben bleiben stehen; Erfolg setzt (Standard) zurück', async () => {
    const aktion = vi
      .fn<Aktion>()
      .mockResolvedValueOnce({ ok: false, error: 'Bitte prüfen.' })
      .mockResolvedValueOnce({ ok: true });
    render(<Formular aktion={aktion} />);
    fireEvent.change(feld('Titel'), { target: { value: 'Abstimmung September' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.getByTestId('stand').textContent).toBe('false'));
    expect(feld('Titel').value).toBe('Abstimmung September');
    expect(aktion.mock.calls[0]![1].get('absicht')).toBe('speichern');

    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.getByTestId('stand').textContent).toBe('true'));
    await waitFor(() => expect(feld('Titel').value).toBe(''));
    expect(aktion).toHaveBeenCalledTimes(2);
  });

  it('zuruecksetzen: false – auch nach Erfolg bleiben Eingaben stehen', async () => {
    const aktion = vi.fn<Aktion>().mockResolvedValue({ ok: true });
    render(<Formular aktion={aktion} optionen={{ zuruecksetzen: false }} />);
    fireEvent.change(feld('Titel'), { target: { value: 'bleibt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.getByTestId('stand').textContent).toBe('true'));
    expect(feld('Titel').value).toBe('bleibt');
  });

  it('blockiert den Doppelklick während der Aktion und nimmt direkt nach der Rückmeldung den nächsten Submit an', async () => {
    const d = deferred();
    const aktion = vi
      .fn<Aktion>()
      .mockReturnValueOnce(d.promise)
      .mockResolvedValueOnce({ ok: false, error: 'Bitte prüfen.' });
    const sofortErneutSenden = vi.fn((form: HTMLFormElement) => {
      expect(form.hasAttribute('aria-busy')).toBe(false);
      expect(within(form).getByTestId('stand').textContent).toBe('true');
      fireEvent.submit(form);
    });
    render(<Formular aktion={aktion} nachErfolg={sofortErneutSenden} />);
    const form = screen.getByRole('form', { name: 'Testformular' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByTestId('stand').textContent).toBe('läuft'));
    expect(aktion).toHaveBeenCalledOnce();
    await act(async () => d.resolve({ ok: true }));
    expect(sofortErneutSenden).toHaveBeenCalledOnce();
    expect(aktion).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('stand').textContent).toBe('false');
  });

  it('Bestätigung je Knopf: ohne Zustimmung kein Aufruf, mit Zustimmung genau einer', async () => {
    h.fragen = [];
    const aktion = vi.fn<Aktion>().mockResolvedValue({ ok: true });
    render(
      <Formular
        aktion={aktion}
        optionen={{
          zuruecksetzen: false,
          bestaetigung: (knopf) =>
            knopf instanceof HTMLButtonElement && knopf.value === 'loeschen'
              ? { text: 'Wirklich löschen?', gefahr: true }
              : null,
        }}
      />,
    );
    h.bestaetigt = false;
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(h.fragen).toEqual(['Wirklich löschen?']));
    expect(aktion).not.toHaveBeenCalled();
    h.bestaetigt = true;
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(aktion.mock.calls[0]![1].get('absicht')).toBe('loeschen');
    await waitFor(() => expect(screen.getByTestId('stand').textContent).toBe('true'));
    // Ohne Rückfrage für den anderen Knopf.
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aktion).toHaveBeenCalledTimes(2));
    expect(h.fragen).toHaveLength(2);
  });

  it('TCMS-DIENST-001: offene Rückfrage bestätigt genau den angezeigten Antrag und Submitter', async () => {
    const frage = deferred<boolean>();
    const dialog = vi.mocked(confirmDialog);
    dialog.mockClear();
    dialog.mockReturnValueOnce(frage.promise);
    const aktion = vi.fn<Aktion>().mockResolvedValue({ ok: true });
    const optionen = { bestaetigung: { text: 'Antrag bestätigen?' } };
    const { rerender } = render(<Formular aktion={aktion} optionen={optionen} antrag="alt" />);
    fireEvent.change(feld('Titel'), { target: { value: 'geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(aktion).not.toHaveBeenCalled();
    rerender(<Formular aktion={aktion} optionen={optionen} antrag="neu" />);
    fireEvent.change(feld('Titel'), { target: { value: 'geändert' } });
    await act(async () => frage.resolve(true));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(Object.fromEntries(aktion.mock.calls[0]![1])).toMatchObject({
      antrag: 'alt',
      titel: 'geprüft',
      absicht: 'loeschen',
    });
  });

  it('nach Abbruch kann die nächste Rückfrage den inzwischen sichtbaren Antrag bestätigen', async () => {
    const frage = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(frage.promise).mockResolvedValueOnce(true);
    const aktion = vi.fn<Aktion>().mockResolvedValue({ ok: true });
    const optionen = { bestaetigung: { text: 'Bestätigen?' } };
    const { rerender } = render(<Formular aktion={aktion} optionen={optionen} antrag="alt" />);
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    rerender(<Formular aktion={aktion} optionen={optionen} antrag="neu" />);
    await act(async () => frage.resolve(false));
    expect(aktion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(Object.fromEntries(aktion.mock.calls[0]![1])).toMatchObject({
      antrag: 'neu',
      absicht: 'speichern',
    });
  });

  it('nachLesen läuft nach dem Lesen der Daten (Code geht mit, Feld ist danach leer)', async () => {
    const aktion = vi.fn<Aktion>().mockResolvedValue({ ok: false, error: 'falsch' });
    render(
      <Formular
        aktion={aktion}
        optionen={{
          zuruecksetzen: false,
          nachLesen: (form) => {
            (form.elements.namedItem('code') as HTMLInputElement).value = '';
          },
        }}
      />,
    );
    fireEvent.change(feld('Code'), { target: { value: '481516' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(aktion.mock.calls[0]![1].get('code')).toBe('481516');
    expect(feld('Code').value).toBe('');
  });
});

describe('Formulare der Bereiche mit dem gemeinsamen Baustein', () => {
  it('TCMS-DIENST-001: Version 1 legt den beim Öffnen der Rückfrage geprüften Entwurf vor', async () => {
    const { einrichtungSpeichernAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions');
    const { SchrittKontrollen } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/einrichtung/schritte');
    const aktion = vi.mocked(einrichtungSpeichernAction).mockResolvedValue({ ok: true });
    const frage = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(frage.promise);
    const props = {
      mandantId: 'm',
      darf: true,
      gesperrtGrund: '',
      gruppen: [],
      start: {},
      kanzlei: [],
      mandant: [],
      zusammenfassung: null,
    };
    const { rerender } = render(<SchrittKontrollen {...props} gesehen={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tax-CMS Version 1 anlegen' }));
    rerender(<SchrittKontrollen {...props} gesehen={4} />);
    await act(async () => frage.resolve(true));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(Object.fromEntries(aktion.mock.calls[0]![2])).toMatchObject({
      gesehen: '3',
      ziel: 'anlegen',
      schritt: '5',
    });
  });

  it('Bereich C, Feststellung erfassen: abgewiesene Eingaben bleiben im Dialog stehen', async () => {
    const { ErfassenDialog } = await import('../feststellungen/formulare');
    const aktion = vi.fn<Aktion>().mockResolvedValue({
      ok: false,
      error: 'Bitte prüfen Sie Ihre Angaben.',
      fieldErrors: { sachverhalt: ['Bitte prüfen Sie diese Angabe.'] },
    });
    render(
      <ErfassenDialog
        action={aktion}
        disabled={false}
        disabledGrund={null}
        durchfuehrungen={[]}
        risiken={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Feststellung erfassen/ }));
    const dialog = screen.getByRole('dialog');
    const titel = within(dialog).getByLabelText('Titel') as HTMLInputElement;
    fireEvent.change(titel, { target: { value: 'Clearingkonto nicht ausgeglichen' } });
    fireEvent.submit(titel.form!);
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('Nicht ausgeführt.');
    expect(titel.value).toBe('Clearingkonto nicht ausgeglichen');
  });

  it('Kontakte & Rollen: abgewiesene Funktion bleibt stehen', async () => {
    const { kontaktRollenSetzenAction } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/actions');
    vi.mocked(kontaktRollenSetzenAction).mockResolvedValue({ ok: false, error: 'Kein Recht.' });
    const { RollenFormular } =
      await import('@/app/staff/(protected)/clients/[id]/tcms/kontakte/rollen-formular');
    render(
      <RollenFormular
        mandantId="a1000000-0000-4000-8000-000000004711"
        kontaktId="b1000000-0000-4000-8000-000000000011"
        kontaktName="Jana Weller"
        rollen={[{ wert: 'GESETZLICHER_VERTRETER', label: 'Gesetzliche Vertretung' }]}
        aktiveRollen={[]}
        funktion={null}
        rollenZuweisbar
      />,
    );
    const funktion = screen.getByLabelText('Funktion (optional)') as HTMLInputElement;
    fireEvent.change(funktion, { target: { value: 'Geschäftsführerin' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gesetzliche Vertretung' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rollen speichern' }));
    expect(await screen.findByText('Kein Recht.')).toBeTruthy();
    expect(funktion.value).toBe('Geschäftsführerin');
    expect(
      (screen.getByRole('checkbox', { name: 'Gesetzliche Vertretung' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});
