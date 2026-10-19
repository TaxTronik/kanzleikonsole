// TCMS Stufe 3, Bereich D: Abruf einer Anlage einer Portal-Meldung durch die
// Kanzlei (GET /api/staff/clients/:id/tcms/ereignisse/anlage?e=…&h=…).
// Schutzregeln: Einstieg zuerst mit der ID aus dem Pfad; nur der Verweis, den
// das Tax-CMS für genau diesen Hash liefert; Bytes nur über die
// Kanzlei-Auslieferung des geprüften Mandanten; Abweichung → Hinweis.
// Fachkatalog: TCMS-AKTEUR-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ route: vi.fn(), lesen: vi.fn(), ausliefern: vi.fn() }));

vi.mock('server-only', () => ({}));
// Der echte Einstieg wird geladen (feste Antworten); Sitzungen bleiben außen vor.
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/tcms/abruf/auslieferung', () => ({ tcmsVerweisAusliefern: h.ausliefern }));
// Gemeinsamer Einstieg mit echten Antworten; nur Einstieg und Lesen ersetzt.
vi.mock('@/server/tcms/route', async (original) => ({
  ...(await original<typeof import('@/server/tcms/route')>()),
  tcmsMandantRoute: h.route,
  tcmsRouteLesen: h.lesen,
}));

import { NextRequest } from 'next/server';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { GET } from '../route';

const EREIGNIS = 'cmvf9ned0008hdy7dlufu2vuo';
const SHA = 'ab'.repeat(32);
const ROUTE = {
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.leon } },
  akteur: {},
  mandantId: DEMO.talwind,
};
const VERWEIS = {
  dokumentId: 'd0c00000-0000-4000-8000-0000000000b1',
  dateiname: 'Bescheid.pdf',
  mime: 'application/pdf',
  groesse: 2048,
  sha256: SHA,
};

function aufruf(query: string, id: string = DEMO.talwind) {
  const req = new NextRequest(
    `http://localhost/api/staff/clients/${id}/tcms/ereignisse/anlage?${query}`,
  );
  return { req, antwort: GET(req, { params: Promise.resolve({ id }) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.route.mockResolvedValue(ROUTE);
  h.lesen.mockResolvedValue({ ok: true, daten: VERWEIS, requestId: null });
  h.ausliefern.mockResolvedValue({ art: 'AUSGELIEFERT', antwort: new Response('bytes') });
});

describe('GET Ereignis-Anlage (Kanzlei)', () => {
  it('Einstieg mit der Pfad-ID, Verweis des Dienstes, Kanzlei-Auslieferung', async () => {
    const { req, antwort } = aufruf(`e=${EREIGNIS}&h=${SHA}`);
    expect(await (await antwort).text()).toBe('bytes');
    expect(h.route).toHaveBeenCalledWith(DEMO.talwind);
    expect(h.lesen).toHaveBeenCalledWith(ROUTE, ENDPUNKTE.ereignisAnlageLesen, {
      params: { ereignisId: EREIGNIS, sha256: SHA },
    });
    expect(h.ausliefern).toHaveBeenCalledWith(
      req,
      { flaeche: 'KANZLEI', session: ROUTE.session, mandantId: DEMO.talwind },
      VERWEIS,
    );
  });

  it('ohne Einstieg: dessen Antwort, kein Dienstaufruf', async () => {
    const antwort = new Response(null, { status: 404 });
    h.route.mockResolvedValue({ ok: false, antwort });
    expect(await aufruf(`e=${EREIGNIS}&h=${SHA}`).antwort).toBe(antwort);
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('ungültige Anfrage: 404 ohne Dienstaufruf', async () => {
    expect((await aufruf(`e=${EREIGNIS}&h=xyz`).antwort).status).toBe(404);
    expect((await aufruf(`h=${SHA}`).antwort).status).toBe(404);
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Dienst liefert einen anderen Hash: 404, keine Auslieferung', async () => {
    h.lesen.mockResolvedValue({ ok: true, daten: { ...VERWEIS, sha256: 'cd'.repeat(32) } });
    expect((await aufruf(`e=${EREIGNIS}&h=${SHA}`).antwort).status).toBe(404);
    expect(h.ausliefern).not.toHaveBeenCalled();
  });

  it('Abweichung: zurück zur Triage des geprüften Mandanten mit festem Hinweis', async () => {
    h.ausliefern.mockResolvedValue({ art: 'ABWEICHUNG' });
    const r = await aufruf(`e=${EREIGNIS}&h=${SHA}`).antwort;
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(
      `/staff/clients/${DEMO.talwind}/tcms/ereignisse?e=${EREIGNIS}&anlage=abweichend`,
    );
  });
});
