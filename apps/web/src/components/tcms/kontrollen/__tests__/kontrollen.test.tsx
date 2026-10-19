// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Anzeigehilfen der Kontrollmatrix und Formular
// „Zuständigkeiten ändern“. Zur Auswahl stehen nur Personen, die die Seite aus
// der kanzleikonsole lädt; die Aktion prüft jede ID erneut, der Dienst prüft
// Vier-Augen und Pflichtangaben.
// Fachkatalog: TCMS-DIENST-001, TCMS-AKTEUR-001
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEMO } from '@/__tests__/tcms-fixtures';
import type { TcmsAktionsErgebnis } from '../../bereich-b/ergebnis';
import { kontrolleAuditPersonen, kontrolleAuditText } from '../labels';
import { ZustaendigkeitFormular } from '../zustaendigkeit';

type Aktion = (vorher: TcmsAktionsErgebnis | null, fd: FormData) => Promise<TcmsAktionsErgebnis>;

const name = (id: string | null) => (id === DEMO.anna ? 'Anna Akte' : id ? 'Unbekannt' : '—');

describe('Audit-Texte', () => {
  it('Personen-IDs nur über Namen', () => {
    const detail = { beantragtVon: DEMO.anna, begruendung: 'Grund' };
    const text = kontrolleAuditText(detail, name);
    expect(text).toContain('Anna Akte');
    expect(text).not.toContain(DEMO.anna);
    expect(kontrolleAuditPersonen(detail)).toContain(DEMO.anna);
  });
});

describe('ZustaendigkeitFormular', () => {
  const personen = [
    { id: 'A1', name: 'Anna Akte', funktion: null },
    { id: 'B2', name: 'Leon Akte', funktion: 'StB' },
  ];

  it('Gegenzeichnung beim Mandanten sperrt die Kanzleiauswahl; Auswahl bleibt bei Fehlern', async () => {
    const aktion = vi.fn<Aktion>().mockResolvedValue({
      ok: false,
      error: 'Diese Person ist für diesen Mandanten nicht zulässig.',
      fieldErrors: { durchfuehrendId: ['Nicht zulässig.'] },
    });
    render(
      <ZustaendigkeitFormular
        aktion={aktion}
        kontrolleId="K-EC-02"
        standId="ks_2"
        partei="MANDANT"
        parteiLabel="Mandant"
        schluessel={false}
        seitePersonen={[{ id: 'C3', name: 'Murat Akte', funktion: 'Leitung Finanzen' }]}
        kanzleiPersonen={personen}
        durchfuehrendId="C3"
        vertretungId={null}
        gegenzeichnerId="A1"
        gegenzeichnungMandant={false}
        gesperrt={null}
      />,
    );
    const form = screen.getByRole('form', { name: 'Zuständigkeiten ändern' });
    const gegen = within(form).getByRole('combobox', {
      name: /Gegenzeichnung/,
    }) as HTMLSelectElement;
    expect(gegen.value).toBe('a1');
    fireEvent.change(gegen, { target: { value: 'b2' } });
    const haken = within(form).getByRole('checkbox', {
      name: 'Gegenzeichnung durch die Vertretung beim Mandanten',
    });
    fireEvent.click(haken);
    expect(gegen.disabled).toBe(true);
    fireEvent.click(haken);
    expect(gegen.disabled).toBe(false);

    fireEvent.submit(form);
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    const fd = aktion.mock.calls[0]![1];
    expect(fd.get('partei')).toBe('MANDANT');
    expect(fd.get('gegenzeichnerId')).toBe('b2');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(gegen.value).toBe('b2');
    const durch = within(form).getByRole('combobox', { name: 'Durchführend (Mandant)' });
    expect(durch.getAttribute('aria-invalid')).toBe('true');
  });

  it('gesperrt: alle Felder deaktiviert', () => {
    render(
      <ZustaendigkeitFormular
        aktion={vi.fn()}
        kontrolleId="K"
        standId="s"
        partei="KANZLEI"
        parteiLabel="Kanzlei"
        schluessel
        seitePersonen={personen}
        kanzleiPersonen={personen}
        durchfuehrendId="A1"
        vertretungId="B2"
        gegenzeichnerId="A1"
        gegenzeichnungMandant={false}
        gesperrt="Historischer Stand"
      />,
    );
    for (const feld of screen.getAllByRole('combobox')) {
      expect((feld as HTMLSelectElement).matches(':disabled')).toBe(true);
    }
  });
});
