// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: Katalog des Branchenpakets (nur Lesen, nur Daten
// aus @taxtronik/tcms-domain). Der Einstieg `tcmsAdminSeite` ist gemockt; seine
// Prüfkette (Admin/Partner, Modul, Dienst) testet
// server/tcms/__tests__/seite.test.ts.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ seite: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({ tcmsAdminSeite: h.seite }));

import { KATALOG_KONTROLLEN, KATALOG_RISIKEN } from '@taxtronik/tcms-domain';
import { renderServer } from '@/__tests__/render-helpers';
import TcmsKatalogPage from '../page';

async function rendern(tab?: string | string[]) {
  return renderServer(TcmsKatalogPage({ searchParams: Promise.resolve(tab ? { tab } : {}) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue({ ok: true, art: 'ADMIN', session: {}, akteur: {} });
});

describe('Tax-CMS-Katalog', () => {
  it('zeigt Risiken als Standard-Tab mit Pflichthinweis „ungeprüft“', async () => {
    await rendern();
    expect(screen.getByRole('heading', { level: 1, name: 'Tax-CMS-Katalog' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Ungeprüfter Entwurf.');
    const nav = screen.getByRole('navigation', { name: 'Teile des Katalogs' });
    const aktiv = within(nav)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current'));
    expect(aktiv).toHaveLength(1);
    expect(aktiv[0]!.textContent).toContain('Risiken');
    for (const r of KATALOG_RISIKEN.slice(0, 3))
      expect(screen.getAllByText(r.code).length).toBeGreaterThan(0);
  });

  it('Tab „kontrollen“', async () => {
    await rendern('kontrollen');
    expect(screen.getAllByText(KATALOG_KONTROLLEN[0]!.code).length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Teile des Katalogs' });
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toContain('Kontrollen');
  });

  it('Tab „matrix“ (Mehrfachwert: erster zählt)', async () => {
    await rendern(['matrix', 'profil']);
    expect(
      screen.getByRole('table', {
        name: 'Häufigkeitsmatrix Governance-Typ × Bruttoklasse (Startwerte, zu kalibrieren)',
      }),
    ).toBeTruthy();
  });

  it.each(['unbekannt', '<script>', ''])('unbekannter Tab „%s“: Standard', async (tab) => {
    const { container } = await rendern(tab);
    expect(container.innerHTML).not.toContain('<script>');
    const nav = screen.getByRole('navigation', { name: 'Teile des Katalogs' });
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toContain('Risiken');
  });

  it('ohne Admin-Recht bzw. Dienst: Zustand mit Weg zurück, kein Katalog', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } });
    const { container } = await rendern();
    expect(screen.queryByRole('heading', { level: 1, name: 'Tax-CMS-Katalog' })).toBeNull();
    expect(container.textContent).not.toContain(KATALOG_RISIKEN[0]!.titel);
  });
});
