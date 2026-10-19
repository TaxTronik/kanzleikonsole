// @vitest-environment jsdom
// TCMS Stufe 3: gemeinsame UI-Bausteine (Zustände, maskierte Feststellungen,
// Plaketten, Unternavigation, Heatmap, Visualisierungen) – Rollen,
// Beschriftungen und Textalternativen.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pfad: '/staff/clients/m1/tcms', stand: null as string | null }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pfad,
  useSearchParams: () => new URLSearchParams(nav.stand ? { stand: nav.stand } : {}),
}));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import { AnzeigeBadge, HashKurz, KlasseBadge } from '../badges';
import { FeststellungBezeichnung, feststellungText } from '../feststellung';
import { RisikoHeatmap, heatmapHref } from '../heatmap';
import { TcmsMandantNavigation } from '../navigation';
import { Fortschritt, MiniSteps, SchwellenAnzeige, SegmentBalken } from '../visual';
import { TcmsZustand } from '../zustand';

describe('TcmsZustand', () => {
  it('zeigt feste Texte, Neuanmeldung und die requestId nur bei Störungen', () => {
    const { rerender } = render(
      <TcmsZustand zustand={{ art: 'KEIN_ZUGRIFF', neuAnmelden: true }} />,
    );
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeTruthy();
    expect(screen.getByText(/Bitte melden Sie sich erneut an/)).toBeTruthy();
    rerender(<TcmsZustand zustand={{ art: 'NICHT_ERREICHBAR', requestId: 'req-1' }} />);
    expect(screen.getByRole('status').textContent).toContain(
      'Vorgangsnummer für den Support: req-1',
    );
    rerender(
      <TcmsZustand
        zustand={{ art: 'NICHT_KONFIGURIERT' }}
        zurueck={{ href: '/staff/clients/m1', label: 'Zur Mandantenakte' }}
      />,
    );
    expect(screen.queryByText(/Vorgangsnummer/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Zur Mandantenakte' }).getAttribute('href')).toBe(
      '/staff/clients/m1',
    );
  });
});

describe('Feststellungen', () => {
  it('zeigt maskierte Feststellungen nur mit Nummer als „Vertrauliche Feststellung“', () => {
    expect(feststellungText({ maskiert: true, nummer: 'F-1' })).toBe(
      'F-1 · Vertrauliche Feststellung',
    );
    expect(feststellungText({ maskiert: false, nummer: 'F-2', titel: 'OSS' })).toBe('F-2 · OSS');
    // Ein maskierter Eintrag mit (unerwartetem) Titel zeigt ihn trotzdem nicht.
    const unerwartet = { maskiert: true, nummer: 'F-3', titel: 'geheim' } as never;
    const { container } = render(<FeststellungBezeichnung f={unerwartet} />);
    expect(container.textContent).toBe('F-3 · Vertrauliche Feststellung');
  });
});

describe('Plaketten', () => {
  it('Klasse und Status mit Label der Domain und vorhandenen Klassen', () => {
    const { container } = render(
      <>
        <KlasseBadge klasse="KRITISCH" uebersteuert />
        <AnzeigeBadge status="UEBERFAELLIG" />
        <HashKurz wert={'a'.repeat(64)} />
      </>,
    );
    expect(container.querySelector('.badge-red')?.textContent).toContain('kritisch');
    expect(container.textContent).toContain('(übersteuert)');
    expect(screen.getByText('Überfällig').className).toBe('badge-red');
    expect(container.querySelector('.sr-only')).toBeTruthy();
  });
});

describe('TcmsMandantNavigation', () => {
  it('markiert den aktiven Bereich und behält den Stichtag', () => {
    nav.pfad = '/staff/clients/m1/tcms/feststellungen/f1';
    nav.stand = '2026-09-30';
    render(<TcmsMandantNavigation basis="/staff/clients/m1/tcms" />);
    const navigation = screen.getByRole('navigation', { name: 'Bereiche des Tax-CMS' });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(14);
    const aktiv = links.filter((l) => l.getAttribute('aria-current') === 'page');
    expect(aktiv.map((l) => l.textContent)).toEqual(['Feststellungen']);
    expect(links[0]!.getAttribute('href')).toBe('/staff/clients/m1/tcms?stand=2026-09-30');
  });
});

describe('RisikoHeatmap', () => {
  const risiken = [
    {
      code: 'U-1',
      s: 'H' as const,
      w: 'SELTEN' as const,
      brutto: 'KRITISCH' as const,
      design: 'MITTEL' as const,
      betrieb: 'HOCH' as const,
    },
    {
      code: 'U-2',
      s: 'H' as const,
      w: 'SELTEN' as const,
      brutto: 'MITTEL' as const,
      design: 'GERING' as const,
      betrieb: 'GERING' as const,
    },
  ];

  it('beschreibt jede Zelle vollständig und wechselt die Sicht per Schaltfläche', () => {
    render(<RisikoHeatmap risiken={risiken} ziel="/x/risiken" stand="2026-09-30" />);
    const zelle = screen.getByRole('link', {
      name: /Schaden hoch, selten: 2 Risiken, höchste Klasse kritisch: U-1, U-2/,
    });
    expect(zelle.getAttribute('href')).toBe('/x/risiken?stand=2026-09-30&s=H&w=SELTEN');
    expect(zelle.className).toContain('chip-red');
    fireEvent.click(screen.getByRole('button', { name: 'Netto Design' }));
    expect(screen.getByRole('button', { name: 'Netto Design' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('link', { name: /höchste Klasse mittel/ }).className).toContain(
      'chip-amber',
    );
    expect(screen.getAllByRole('img', { name: /keine Risiken/ }).length).toBe(11);
    expect(heatmapHref('/r', 'N', 'HAEUFIG', null)).toBe('/r?s=N&w=HAEUFIG');
  });
});

describe('Visualisierungen', () => {
  it('haben Textalternativen mit den Zahlen', () => {
    render(
      <>
        <MiniSteps aktiv={3} />
        <Fortschritt anteil={0.5} label="Monat 6 von 12" />
        <SchwellenAnzeige anteil={1.2} label="Anteil an der EU-Lieferschwelle" />
        <SegmentBalken
          label="Durchführungen"
          teile={[
            { label: 'ohne Befund', wert: 3, fuellung: 'gruen' },
            { label: 'offen', wert: 1, fuellung: 'brand' },
          ]}
        />
      </>,
    );
    expect(screen.getByRole('img', { name: /Phase 3 von 7: Kontrollplanung/ })).toBeTruthy();
    expect(
      screen.getByRole('meter', { name: 'Monat 6 von 12' }).getAttribute('aria-valuenow'),
    ).toBe('50');
    const schwelle = screen.getByRole('meter', { name: 'Anteil an der EU-Lieferschwelle' });
    expect(schwelle.getAttribute('aria-valuetext')).toBe('120 %');
    expect(schwelle.getAttribute('aria-valuenow')).toBe('100');
    expect(
      screen.getByRole('img', { name: 'Durchführungen: 3 ohne Befund, 1 offen' }),
    ).toBeTruthy();
    expect(screen.getByText('3 ohne Befund')).toBeTruthy();
  });
});
