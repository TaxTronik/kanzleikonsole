// @vitest-environment jsdom
// TCMS Stufe 3: Tax-CMS-Portfolio als Render-Test mit der Antwort des Dienstes
// (Demo-Daten). Namen und Mandantenmenge kommen aus der kanzleikonsole: nur
// Mandanten der bestätigten Liste, Mandanten ohne Anker als „nicht angelegt“.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ seite: vi.fn(), lesen: vi.fn(), mandanten: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({ tcmsKanzleiSeite: h.seite, tcmsLesen: h.lesen }));
vi.mock('@/server/tcms/portfolio', () => ({ portfolioMandanten: h.mandanten }));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import TcmsPortfolioPage from '../page';

const NEU = 'c1000000-0000-4000-8000-000000000001';
const SEITE = {
  ok: true,
  art: 'KANZLEI',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna } },
  akteur: {},
  liste: {
    mandantIds: [DEMO.talwind, DEMO.seestern, DEMO.bergkamm, NEU],
    bt: [DEMO.talwind],
    hb: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.portfolioDemo(), requestId: null });
  // Kleinwerk und Pixelhafen stehen nicht in der Liste der kanzleikonsole.
  h.mandanten.mockResolvedValue([
    {
      id: DEMO.bergkamm,
      name: 'Bergkamm Kaffeerösterei GmbH',
      berufstraeger: [],
      zustaendig: false,
    },
    { id: NEU, name: 'Neu Handel GmbH', berufstraeger: ['StB Thomas Kern'], zustaendig: false },
    {
      id: DEMO.seestern,
      name: 'Seestern Home & Living GmbH',
      berufstraeger: ['StB Thomas Kern'],
      zustaendig: false,
    },
    {
      id: DEMO.talwind,
      name: 'Talwind Outdoor GmbH',
      berufstraeger: ['StB Dr. Anna Roth'],
      zustaendig: true,
    },
  ]);
});

const zeilen = () => (screen.getAllByRole('row') as HTMLTableRowElement[]).slice(1);

describe('Tax-CMS-Portfolio', () => {
  it('zeigt nur Mandanten der kanzleikonsole, mit Namen und Berufsträger:innen aus ihr', async () => {
    const { container } = await renderServer(
      TcmsPortfolioPage({ searchParams: Promise.resolve({}) }),
    );
    expect(h.lesen).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'portfolioLesen' }),
    );
    expect(zeilen()).toHaveLength(4);
    expect(container.textContent).not.toContain('Kleinwerk');
    expect(container.textContent).not.toContain('Pixelhafen');
    const neu = zeilen().find((z) => z.textContent?.includes('Neu Handel GmbH'))!;
    expect(within(neu).getByText('nicht im Tax-CMS angelegt')).toBeTruthy();
    const talwind = zeilen().find((z) => z.textContent?.includes('Talwind'))!;
    expect(within(talwind).getByText('StB Dr. Anna Roth')).toBeTruthy();
    expect(
      within(talwind).getByRole('link', { name: 'Talwind Outdoor GmbH' }).getAttribute('href'),
    ).toBe(`/staff/clients/${DEMO.talwind}/tcms`);
    // Kennzahlen aus der Antwort des Dienstes.
    expect(screen.getByText('Mandanten mit Tax-CMS').previousSibling?.textContent).toBe('4');
  });

  it('filtert per GET nach Name, Zuständigkeit und Phase, ohne neu zu rechnen', async () => {
    await renderServer(TcmsPortfolioPage({ searchParams: Promise.resolve({ q: 'see' }) }));
    expect(zeilen().map((z) => z.cells[0]!.textContent)).toEqual([
      expect.stringContaining('Seestern'),
    ]);
    document.body.innerHTML = '';
    await renderServer(TcmsPortfolioPage({ searchParams: Promise.resolve({ zustaendig: '1' }) }));
    expect(zeilen()).toHaveLength(1);
    document.body.innerHTML = '';
    await renderServer(TcmsPortfolioPage({ searchParams: Promise.resolve({ phase: 'ohne' }) }));
    expect(zeilen().map((z) => z.cells[0]!.textContent)).toEqual([
      expect.stringContaining('Bergkamm'),
      expect.stringContaining('Neu Handel'),
    ]);
    document.body.innerHTML = '';
    await renderServer(TcmsPortfolioPage({ searchParams: Promise.resolve({ phase: '9; drop' }) }));
    expect(zeilen()).toHaveLength(4);
  });

  it('zeigt einen Zustand statt Daten, wenn der Dienst nicht erreichbar ist', async () => {
    h.lesen.mockResolvedValue({ ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: null } });
    await renderServer(TcmsPortfolioPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
    expect(h.mandanten).not.toHaveBeenCalled();
  });
});
