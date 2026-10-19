// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Anzeigehilfen des Länder-Monitors und Formular
// „Neuen Stand erfassen“ (Eingaben bleiben bei Feldfehlern stehen).
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import type { TcmsAktionsErgebnis } from '../../bereich-b/ergebnis';
import { profilKanaele, standUnterschiede } from '../anzeige';
import { LandStandFormular } from '../formulare';

type Aktion = (vorher: TcmsAktionsErgebnis | null, fd: FormData) => Promise<TcmsAktionsErgebnis>;

describe('Länder-Anzeige', () => {
  it('Unterschiede zweier Stände; Verkaufskanäle aus dem Profil', () => {
    const [neu, alt] = tcmsFixtures.laenderTalwind().historie.find((h) => h.land === 'CZ')!.staende;
    const d = standUnterschiede(alt!, neu!);
    expect(d[0]).toMatch(/^Fernverkäufe 0\s€ → 61\.200\s€$/);
    expect(
      profilKanaele({
        p1: { eigenerShop: true, shopSystem: 'Shopware', marktplaetze: ['Amazon', 3] },
      }),
    ).toEqual(['eigener Shop (Shopware)', 'Amazon']);
    expect(profilKanaele(null as never)).toEqual([]);
  });
});

describe('LandStandFormular', () => {
  it('Eingaben bleiben bei Feldfehlern stehen (kein automatisches Zurücksetzen)', async () => {
    const aktion = vi.fn<Aktion>().mockResolvedValue({
      ok: false,
      error: 'Bitte prüfen Sie Ihre Angaben.',
      fieldErrors: { fernverkaeufeLfdEur: ['Bitte einen Betrag ab 0 € angeben.'] },
    });
    render(
      <LandStandFormular
        aktion={aktion}
        heute="2026-10-19"
        land={{
          land: 'FR',
          fernverkaeufeLfdEur: 241900,
          fernverkaeufeVorjahrEur: 0,
          lagerSeit: null,
          oss: true,
          lokaleUstNr: false,
          zmRelevant: false,
          steuersaetzeGeprueftAm: null,
          stand: '2026-09-30',
        }}
      />,
    );
    const form = screen.getByRole('form', { name: 'Neuen Stand für FR erfassen' });
    const lfd = within(form).getByRole('textbox', {
      name: /Fernverkäufe lfd\. Jahr/,
    }) as HTMLInputElement;
    expect(lfd.value).toBe('241900');
    fireEvent.change(lfd, { target: { value: '1,234.56' } });
    fireEvent.submit(form);
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect(aktion.mock.calls[0]![1].get('land')).toBe('FR');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(lfd.value).toBe('1,234.56');
    expect(lfd.getAttribute('aria-invalid')).toBe('true');
  });
});
