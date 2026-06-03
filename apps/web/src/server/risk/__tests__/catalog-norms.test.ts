import { describe, it, expect, vi, beforeEach } from 'vitest';

// @taxtronik/db (Barrel) verlangt DATABASE_URL beim Import + macht echte Tx →
// mocken. withTenantContext ruft die Callback mit einer Fake-Tx; evidenceService
// ist ein Spy. vi.hoisted, damit die Mock-Factory den State referenzieren darf.
const h = vi.hoisted(() => ({
  marking: { begriffId: 'ao_schaetzung' } as { begriffId: string | null } | null,
  record: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ riskMarking: { findUnique: async () => h.marking } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
// Verhindert, dass der Paket-Import @taxtronik/config (ENV-Validierung) zieht —
// der echte Client wird hier injiziert, new RiskLayerClient() nie erreicht.
vi.mock('@taxtronik/risk-layer', () => ({ RiskLayerClient: class {} }));

import { kuratiereKatalogNorm, NotACatalogMarkingError, CatalogCurationFailedError } from '../catalog-norms';

type Ctx = Parameters<typeof kuratiereKatalogNorm>[0];
type Client = Parameters<typeof kuratiereKatalogNorm>[2];
const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' } as unknown as Ctx;
const input = { markingId: 'm1', norm: '§ 162 AO', aktion: 'verwerfen', scope: 'geteilt', autor: 's1' } as const;

beforeEach(() => {
  h.marking = { begriffId: 'ao_schaetzung' };
  h.record.mockReset();
});

describe('kuratiereKatalogNorm', () => {
  it('ruft die Engine mit begriffId als katalogId + autor und auditiert bei Erfolg', async () => {
    const client = { katalogNormKuratieren: vi.fn(async () => ({ ok: true })) };
    await kuratiereKatalogNorm(ctx, input, client as unknown as Client);

    expect(client.katalogNormKuratieren).toHaveBeenCalledWith({
      katalogId: 'ao_schaetzung', norm: '§ 162 AO', aktion: 'verwerfen', scope: 'geteilt', autor: 's1',
    });
    expect(h.record).toHaveBeenCalledTimes(1);
    const ev = h.record.mock.calls[0]![1] as { action: string; resourceId: string; after: Record<string, unknown> };
    expect(ev.action).toBe('risk.catalog.norm_curated');
    expect(ev.resourceId).toBe('ao_schaetzung');
    expect(ev.after).toMatchObject({ katalogId: 'ao_schaetzung', norm: '§ 162 AO', aktion: 'verwerfen', scope: 'geteilt' });
  });

  it('wirft NotACatalogMarkingError ohne begriffId — kein Engine-Call, kein Audit', async () => {
    h.marking = { begriffId: null };
    const client = { katalogNormKuratieren: vi.fn(async () => ({ ok: true })) };
    await expect(kuratiereKatalogNorm(ctx, input, client as unknown as Client)).rejects.toBeInstanceOf(NotACatalogMarkingError);
    expect(client.katalogNormKuratieren).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('wirft CatalogCurationFailedError bei ok:false und auditiert NICHT', async () => {
    const client = { katalogNormKuratieren: vi.fn(async () => ({ ok: false, fehler: 'unbekannte katalog_id' })) };
    await expect(kuratiereKatalogNorm(ctx, input, client as unknown as Client)).rejects.toThrow('unbekannte katalog_id');
    expect(h.record).not.toHaveBeenCalled();
  });
});
