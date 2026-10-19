// @vitest-environment jsdom
// TCMS Stufe 3, Bereich D: Ereigniseingang und Triage als Render-Test mit
// Antworten des Dienstes (Demo: Talwind, 2026-T-0345 als Portal-Meldung).
// Schutzregeln der Anzeige:
//   - Vier-Augen beim Verwerfen: Wer den Antrag gestellt hat, sieht kein
//     „Verwerfen bestätigen“, nur „Antrag zurückziehen“ (entscheiden tut der
//     Dienst; die Aktion bildet seine Ablehnung ab).
//   - Ohne Bearbeitungsrecht laut Kontext bzw. zum historischen Stichtag:
//     Aktionen gesperrt mit sichtbarem Grund.
//   - Anlagen nur über den Abruf mit Hash; Hinweise nur für bekannte Codes.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/tcms/seite', () => ({
  tcmsMandantSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsLesenOptional: h.lesenOptional,
  tcmsNamenLesen: h.namen,
  tcmsTenantLesen: h.tenantLesen,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsEreignissePage from '../ereignisse/page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const SEITE = {
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.leon } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  basis: BASIS,
};
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.leon]: 'Leon Brandt',
  [DEMO.murat]: 'Murat Aydin',
};
const PERSONEN = {
  optionen: [
    { wert: `K:${DEMO.leon}`, label: 'Leon Brandt (Kanzlei)' },
    { wert: `M:${DEMO.murat}`, label: 'Murat Aydin (Mandant)' },
  ],
  berufstraeger: `K:${DEMO.anna}`,
  hauptbearbeitung: `K:${DEMO.leon}`,
};
const BEGRUENDUNG = 'Doppelte Meldung, bereits als 2026-T-0342 in Bearbeitung genommen.';

let kontext = tcmsFixtures.kontextTalwind();
let ereignis = tcmsFixtures.ereignis0345();

function seite(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsEreignissePage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwind();
  ereignis = tcmsFixtures.ereignis0345();
  h.seite.mockResolvedValue(SEITE);
  h.lesenOptional.mockImplementation(async (_s, e: { name: string }) => ({
    ok: true,
    daten: e.name === 'kontextLesen' ? kontext : tcmsFixtures.ereignisseTalwind(),
    requestId: 'r',
  }));
  h.lesen.mockImplementation(async () => ({ ok: true, daten: ereignis, requestId: 'r' }));
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.tenantLesen.mockResolvedValue(PERSONEN);
});

describe('Ereigniseingang', () => {
  it('Liste und Triage des ersten neuen Ereignisses; Vorschläge mit Zuständigkeit aus der kanzleikonsole', async () => {
    await seite();
    expect(h.lesen).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'ereignisLesen' }),
      { params: { ereignisId: ereignis.id }, query: {} },
    );
    expect(screen.getAllByText('2026-T-0345').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-T-0342').length).toBeGreaterThan(0);
    for (const f of ereignis.folgen) expect(screen.getByText(f.text)).toBeTruthy();
    const vorschlaege = document.querySelectorAll<HTMLInputElement>('input[name="folge"]');
    expect([...vorschlaege].map((c) => c.value)).toEqual(ereignis.folgen.map((f) => f.id));
    // Zuständigkeit: nur Personen aus der Auswahl der kanzleikonsole.
    const optionen = screen
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'))
      .filter((v) => v?.startsWith('K:') || v?.startsWith('M:'));
    expect(new Set(optionen)).toEqual(new Set([`K:${DEMO.leon}`, `M:${DEMO.murat}`]));
    expect(screen.getByRole('button', { name: 'In Prüfung nehmen' })).toBeTruthy();
  });

  it('Auswahl nur aus der Liste; unbekannte ID → erstes offenes Ereignis', async () => {
    await seite({ e: 'cmvf9ned0008hdy7dfremd0000' });
    expect(h.lesen).toHaveBeenCalledWith(SEITE, expect.anything(), {
      params: { ereignisId: ereignis.id },
      query: {},
    });
  });

  it('Vier-Augen: eigener Antrag ohne „Verwerfen bestätigen“, nur Zurückziehen', async () => {
    ereignis.verwerfenAntrag = {
      vonId: DEMO.leon,
      am: '2026-10-19T09:00:00.000Z',
      begruendung: BEGRUENDUNG,
    };
    await seite();
    expect(screen.queryByRole('button', { name: 'Verwerfen bestätigen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Antrag zurückziehen' })).toBeTruthy();
    expect(screen.getByText(/zweite Person erfolgen/)).toBeTruthy();
  });

  it('Vier-Augen: Antrag einer anderen Person kann bestätigt oder abgelehnt werden', async () => {
    ereignis.verwerfenAntrag = {
      vonId: DEMO.anna,
      am: '2026-10-19T09:00:00.000Z',
      begruendung: BEGRUENDUNG,
    };
    await seite();
    expect(screen.getByRole('button', { name: 'Verwerfen bestätigen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Antrag zurückziehen' })).toBeNull();
  });

  it('ohne Bearbeitungsrecht laut Kontext: Aktionen gesperrt mit Grund, keine Personenabfrage', async () => {
    kontext.rechte.bearbeiten = false;
    await seite();
    const knopf = screen.getByRole('button', { name: 'In Prüfung nehmen' }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(screen.getAllByText(TCMS_KEIN_RECHT.BEARBEITEN).length).toBeGreaterThan(0);
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('Anlagen über den Abruf mit Hash; Hinweis nur für bekannte Codes', async () => {
    const sha = 'ab'.repeat(32);
    ereignis.anlagen = [
      { dateiname: 'Bescheid.pdf', mime: 'application/pdf', groesse: 2048, sha256: sha },
    ];
    await seite({ anlage: 'abweichend' });
    const link = screen.getByRole('link', { name: /Bescheid\.pdf/ });
    expect(link.getAttribute('href')).toBe(
      `/api${BASIS}/ereignisse/anlage?e=${encodeURIComponent(ereignis.id)}&h=${sha}`,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/SHA-256/);

    document.body.innerHTML = '';
    await seite({ anlage: 'constructor' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Mandant noch nicht im Tax-CMS: Hinweis statt Liste', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: 'r' });
    await seite();
    expect(screen.getByText(/noch kein Tax-CMS eingerichtet/)).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('erledigtes Ereignis: Verlauf und Abschluss, keine Vorschlagsauswahl', async () => {
    ereignis = tcmsFixtures.ereignis0329();
    await seite({ e: ereignis.id });
    const panel = screen.getAllByRole('region').find((r) => within(r).queryByText(ereignis.titel));
    expect(panel).toBeTruthy();
    expect(document.querySelectorAll('input[name="folge"]')).toHaveLength(0);
  });
});
