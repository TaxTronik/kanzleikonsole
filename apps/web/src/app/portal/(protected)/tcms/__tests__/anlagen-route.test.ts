// TCMS Stufe 3, Bereich D: Abruf einer Anlage im Portal
// (GET /portal/tcms/aufgaben/:id/anlagen/:nachweisId). Schutzregeln:
//   - Einstieg zuerst; Mandant nur aus der Sitzung (nie aus dem Pfad).
//   - Lese-Limit des Portals vor dem Dienstaufruf.
//   - Der Verweis muss zu genau der Aufgabe im Pfad gehören.
//   - Bytes nur über die Portal-Auslieferung; Abweichung → Hinweis, keine Bytes.
// Fachkatalog: TCMS-AKTEUR-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  route: vi.fn(),
  lesen: vi.fn(),
  ausliefern: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
// Einstieg mit echten Antworten, aber ohne Seiten-Helfer (Sitzung, Datenbank).
vi.mock('@/server/tcms/seite', () => ({}));
vi.mock('@/server/rate-limit', () => ({ checkPortalReadLimit: h.limit }));
vi.mock('@/server/tcms/abruf/auslieferung', () => ({ tcmsVerweisAusliefern: h.ausliefern }));
vi.mock('@/server/tcms/abruf/einstieg', async (original) => ({
  ...(await original<typeof import('@/server/tcms/abruf/einstieg')>()),
  tcmsPortalRoute: h.route,
  tcmsRouteLesen: h.lesen,
}));

import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { DEMO } from '@/__tests__/tcms-fixtures';
import { GET } from '../aufgaben/[id]/anlagen/[nachweisId]/route';

const AUFGABE = 'cmvf9ne7i007kdy7d467junj7';
const ANDERE = 'cmvf9ne7i007kdy7d467junj8';
const NACHWEIS = 'cmvf9ne96007qdy7d0c2yfigq';
const ROUTE = {
  ok: true,
  art: 'PORTAL',
  session: { user: { tenantId: DEMO.tenant, contactId: DEMO.murat, clientId: DEMO.talwind } },
  akteur: {},
  mandantId: DEMO.talwind,
};
const VERWEIS = {
  dokumentId: 'd0c00000-0000-4000-8000-0000000000a1',
  dateiname: 'a.csv',
  mime: 'text/csv',
  groesse: 117,
  sha256: 'ab'.repeat(32),
};
const REQ = {} as never;

function aufruf(id = AUFGABE, nachweisId = NACHWEIS) {
  return GET(REQ, { params: Promise.resolve({ id, nachweisId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.route.mockResolvedValue(ROUTE);
  h.limit.mockResolvedValue({ ok: true });
  h.lesen.mockResolvedValue({
    ok: true,
    daten: { durchfuehrungId: AUFGABE, nachweis: VERWEIS },
    requestId: null,
  });
  h.ausliefern.mockResolvedValue({ art: 'AUSGELIEFERT', antwort: new Response('bytes') });
});

describe('GET Portal-Anlage', () => {
  it('liefert über die Portal-Auslieferung mit dem Sitzungsmandanten und dem Verweis des Dienstes', async () => {
    const r = await aufruf();
    expect(await r.text()).toBe('bytes');
    expect(h.route).toHaveBeenCalledWith();
    expect(h.lesen).toHaveBeenCalledWith(ROUTE, ENDPUNKTE.portalAnlageLesen, {
      params: { nachweisId: NACHWEIS },
    });
    expect(h.ausliefern).toHaveBeenCalledWith(
      REQ,
      { flaeche: 'PORTAL', session: ROUTE.session, mandantId: DEMO.talwind },
      VERWEIS,
    );
  });

  it('ohne Einstieg: dessen Antwort, kein Dienstaufruf', async () => {
    const antwort = new Response(null, { status: 404 });
    h.route.mockResolvedValue({ ok: false, antwort });
    expect(await aufruf()).toBe(antwort);
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Lese-Limit vor dem Dienstaufruf', async () => {
    h.limit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const r = await aufruf();
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    expect(h.limit).toHaveBeenCalledWith(DEMO.murat);
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Verweis einer anderen Aufgabe: 404, keine Auslieferung', async () => {
    const r = await aufruf(ANDERE);
    expect(r.status).toBe(404);
    expect(h.ausliefern).not.toHaveBeenCalled();
  });

  it('ungültige IDs: 404 ohne Dienstaufruf', async () => {
    expect((await aufruf('../x')).status).toBe(404);
    expect((await aufruf(AUFGABE, 'a b')).status).toBe(404);
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Abweichung oder nicht verfügbar: zurück zur Aufgabe mit festem Hinweis', async () => {
    h.ausliefern.mockResolvedValue({ art: 'ABWEICHUNG' });
    let r = await aufruf();
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/portal/tcms/aufgaben/${AUFGABE}?anlage=abweichend`);
    h.ausliefern.mockResolvedValue({ art: 'NICHT_VERFUEGBAR' });
    r = await aufruf();
    expect(r.headers.get('location')).toBe(
      `/portal/tcms/aufgaben/${AUFGABE}?anlage=nicht-verfuegbar`,
    );
  });
});
