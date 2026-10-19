// @vitest-environment jsdom
// TCMS Stufe 3, Bereich D: Audit-Protokoll des Tax-CMS (/staff/tcms/audit).
// Schutzregeln:
//   - Nur Admins und Partner: Seite über tcmsAdminSeite, Kettenprüfung mit
//     `nurAdmin` und festem Text bei 403 des Dienstes (VERWALTUNG).
//   - Die Kette prüft nur der Dienst; die Aktion setzt eine abgebrochene
//     Prüfung mit `weiterAb` fort und rechnet nichts nach.
//   - Personen mit dem im Protokoll festgehaltenen Namen; Filter nur in
//     gültiger Form (sonst ohne Filter).
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { ENDPUNKTE, MAX_AUDIT_POS } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  mandanten: vi.fn(),
  spec: null as null | Record<string, unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({
  tcmsAdminSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsTenantLesen: (_seite: unknown, f: (tx: unknown) => unknown) =>
    f({ client: { findMany: h.mandanten } }),
}));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { auditPruefenAction } from '../audit/actions';
import TcmsAuditPage from '../audit/page';

const SEITE = {
  ok: true,
  art: 'ADMIN',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna } },
  akteur: {},
};

function seite(sp: Record<string, string> = {}) {
  return renderServer(TcmsAuditPage({ searchParams: Promise.resolve(sp) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.seite.mockResolvedValue(SEITE);
  h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.auditAnna(), requestId: null });
  h.mandanten.mockResolvedValue([
    { id: DEMO.pixelhafen, name: 'Pixelhafen GmbH' },
    { id: DEMO.kleinwerk, name: 'Kleinwerk Manufaktur GmbH' },
  ]);
});

describe('Audit-Seite', () => {
  it('ohne Admin-Seite (Zustand): keine Liste, kein Dienstaufruf', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: false } });
    await seite();
    expect(screen.getByRole('heading', { name: 'Kein Zugriff' })).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('neueste zuerst, Name laut Protokoll, Mandant aus der kanzleikonsole, Blättern über `vor`', async () => {
    const daten = tcmsFixtures.auditAnna();
    await seite();
    expect(h.lesen).toHaveBeenCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { vor: String(MAX_AUDIT_POS), limit: '50' },
    });
    const zeilen = screen.getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(daten.eintraege.length);
    const erste = within(zeilen[0]!);
    expect(erste.getByText(daten.eintraege[0]!.actorName)).toBeTruthy();
    expect(erste.getByText('Pixelhafen GmbH')).toBeTruthy();
    expect(screen.getByRole('link', { name: /ältere/ }).getAttribute('href')).toBe(
      `/staff/tcms/audit?vor=${daten.weiter}`,
    );
    expect(screen.getByRole('button', { name: /Hashkette prüfen/ })).toBeTruthy();
  });

  it('Filter nur in gültiger Form an den Dienst', async () => {
    await seite({ mandant: 'kein-uuid', aktion: 'tcms.ereignis', vor: '27' });
    expect(h.lesen).toHaveBeenCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { aktion: 'tcms.ereignis', vor: '27', limit: '50' },
    });
    await seite({ mandant: DEMO.talwind.toUpperCase(), vor: '99999999999' });
    expect(h.lesen).toHaveBeenLastCalledWith(SEITE, ENDPUNKTE.auditLesen, {
      query: { mandantId: DEMO.talwind, vor: String(MAX_AUDIT_POS), limit: '50' },
    });
  });
});

describe('auditPruefenAction', () => {
  interface Spec {
    mandantId: string | null;
    nurAdmin?: boolean;
    keinRecht?: string;
    aufruf: (dienst: unknown) => Promise<unknown>;
  }
  function spec(): Spec {
    expect(h.spec).not.toBeNull();
    return h.spec as unknown as Spec;
  }

  it('nur Admin/Partner, kanzleiweit, fester Text bei fehlendem Verwaltungsrecht', async () => {
    await auditPruefenAction(null, new FormData());
    expect(spec().nurAdmin).toBe(true);
    expect(spec().mandantId).toBeNull();
    expect(spec().keinRecht).toBe('VERWALTUNG');
  });

  it('setzt eine abgebrochene Prüfung mit `weiterAb` fort, bis der Dienst ein Ergebnis meldet', async () => {
    await auditPruefenAction(null, new FormData());
    const antworten = [
      { status: 'ABGEBROCHEN', geprueft: 20, bruchBei: null, grund: null, weiterAb: 20 },
      { status: 'INTAKT', geprueft: 11, bruchBei: null, grund: null, weiterAb: null },
    ];
    const rufe = vi.fn(async () => ({ daten: antworten.shift(), requestId: 'r' }));
    const r = await spec().aufruf({ rufe });
    expect(rufe.mock.calls).toEqual([
      [ENDPUNKTE.auditPruefen, { body: {} }],
      [ENDPUNKTE.auditPruefen, { body: { ab: 20 } }],
    ]);
    expect(r).toEqual({ meldung: expect.stringContaining('31 Einträge geprüft') });
  });

  it('gebrochene Kette: Warnung mit Position laut Dienst', async () => {
    await auditPruefenAction(null, new FormData());
    const rufe = vi.fn(async () => ({
      daten: {
        status: 'GEBROCHEN',
        geprueft: 7,
        bruchBei: 8,
        grund: 'Hash passt nicht',
        weiterAb: null,
      },
      requestId: 'r',
    }));
    const r = await spec().aufruf({ rufe });
    expect(r).toEqual({ warnung: expect.stringContaining('#8 (laut Tax-CMS: Hash passt nicht)') });
  });
});
