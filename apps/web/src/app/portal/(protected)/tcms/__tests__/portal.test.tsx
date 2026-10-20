// @vitest-environment jsdom
// TCMS Stufe 3: Tax-CMS im Portal als Render-Test mit der Antwort des
// Dienstes (Demo: Jana Weller, gesetzliche Vertretung der Talwind Outdoor GmbH).
// Rechte und Aufgabenauswahl kommen aus der Antwort; Namen aus der kanzleikonsole.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ seite: vi.fn(), lesen: vi.fn(), namen: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({
  tcmsPortalSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsNamenLesen: h.namen,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import PortalTcmsPage from '../page';

const SEITE = {
  ok: true,
  art: 'PORTAL',
  session: { user: { tenantId: DEMO.tenant, contactId: DEMO.jana, clientId: DEMO.talwind } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.namen.mockResolvedValue({
    name: (id: string | null) =>
      id === DEMO.jana ? 'Jana Weller' : id ? UNBEKANNTE_PERSON : KEINE_PERSON,
    bekannt: (id: string | null) => id === DEMO.jana,
  });
});

describe('Tax-CMS im Portal', () => {
  it('zeigt Stand, eigene und weitere Aufgaben und Meldungen aus der Antwort', async () => {
    const daten = tcmsFixtures.portalUebersichtJana();
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    await renderServer(PortalTcmsPage());
    expect(h.lesen).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'portalUebersichtLesen' }),
    );
    const aufgaben = screen.getByRole('region', { name: 'Ihre Aufgaben' });
    const eigene = daten.aufgaben.filter((a) => a.eigene);
    for (const a of eigene) {
      const link = within(aufgaben)
        .getAllByRole('link')
        .find((l) =>
          l
            .getAttribute('href')
            ?.endsWith(`/portal/tcms/aufgaben/${encodeURIComponent(a.durchfuehrungId)}`),
        );
      expect(link, a.code).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: /Ereignis melden/ }).getAttribute('href')).toBe(
      '/portal/tcms/ereignis',
    );
    expect(screen.getByRole('link', { name: /Freigaben/ }).getAttribute('href')).toBe(
      '/portal/tcms/freigaben',
    );
    expect(screen.getByRole('region', { name: 'Letzte Meldungen' })).toBeTruthy();
  });

  it('ohne Melderecht und ohne Übersicht: feste Hinweise, keine fremden Aufgaben', async () => {
    const daten = tcmsFixtures.portalUebersichtJana();
    daten.rechte = { portalLesen: false, gesetzlicherVertreter: false, melden: false };
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    await renderServer(PortalTcmsPage());
    expect(screen.queryByRole('link', { name: /Ereignis melden/ })).toBeNull();
    expect(screen.getByText(TCMS_KEIN_RECHT.PORTAL_ROLLE)).toBeTruthy();
    expect(screen.queryByText(/Weitere Aufgaben in Ihrem Unternehmen/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Ihre Meldungen' })).toBeTruthy();
  });

  it('ohne Programm: Hinweis der Kanzlei', async () => {
    const daten = tcmsFixtures.portalUebersichtJana();
    daten.programm = null;
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    await renderServer(PortalTcmsPage());
    expect(screen.getByText(/noch kein Tax-Compliance-Programm eingerichtet/)).toBeTruthy();
  });

  it('Zustand bei fehlendem Zugang', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: false } });
    await renderServer(PortalTcmsPage());
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });
});

// kk-tcms-qual (s9-Rest): Aufgaben und Meldungen der Übersicht bleiben isoliert.
describe('Tax-CMS im Portal – Richtungsisolation', () => {
  it('Übersicht mit Aufgaben und Meldungen', async () => {
    const daten = markiert(
      tcmsFixtures.portalUebersichtJana(),
      ENDPUNKTE.portalUebersichtLesen.antwortSchema,
    );
    h.lesen.mockResolvedValue({ ok: true, daten, requestId: null });
    const { container } = await renderServer(PortalTcmsPage());
    erwarteIsoliert(container, 3);
  });
});
