import { describe, it, expect, vi, beforeEach } from 'vitest';

// @taxtronik/db (Barrel) verlangt DATABASE_URL beim Import + macht echte Tx →
// mocken. evidenceService ist ein Spy. Der Paket-Mock liefert RiskLayerHttpError
// als echte Klasse, weil catalog-review.ts per instanceof darauf prüft.
const h = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@taxtronik/risk-layer', () => {
  class RiskLayerHttpError extends Error {
    constructor(
      readonly status: number,
      readonly path: string,
      readonly body: string,
    ) {
      super(`Risk-Layer ${path} antwortete ${status}`);
      this.name = 'RiskLayerHttpError';
    }
  }
  return { RiskLayerClient: class {}, RiskLayerHttpError };
});

import { RiskLayerHttpError } from '@taxtronik/risk-layer';
import { setKatalogReviewStatus, CatalogReviewFailedError } from '../catalog-review';

type Ctx = Parameters<typeof setKatalogReviewStatus>[0];
type Client = Parameters<typeof setKatalogReviewStatus>[2];
const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' } as unknown as Ctx;

beforeEach(() => {
  h.record.mockReset();
});

describe('setKatalogReviewStatus', () => {
  it('ruft die Engine mit pruefer=actorId und verankert den Übergang in der Chain', async () => {
    const client = {
      katalogReview: vi.fn(async () => ({
        ok: true, id: 'b1', alter_status: 'entwurf', neuer_status: 'geprüft', pruefer: 's1',
      })),
    };
    const res = await setKatalogReviewStatus(
      ctx,
      { begriffId: 'b1', status: 'geprüft' },
      client as unknown as Client,
    );

    expect(client.katalogReview).toHaveBeenCalledWith({ id: 'b1', status: 'geprüft', pruefer: 's1' });
    expect(res).toEqual({ alterStatus: 'entwurf', neuerStatus: 'geprüft' });
    expect(h.record).toHaveBeenCalledTimes(1);
    const ev = h.record.mock.calls[0]![1] as {
      action: string; resourceId: string; before: unknown; after: unknown;
    };
    expect(ev.action).toBe('risk.catalog.reviewed');
    expect(ev.resourceId).toBe('b1');
    expect(ev.before).toEqual({ reviewStatus: 'entwurf' });
    expect(ev.after).toEqual({ reviewStatus: 'geprüft', pruefer: 's1' });
  });

  it('übersetzt die 400-Ablehnung (Rückwärts-Übergang) in CatalogReviewFailedError — kein Audit', async () => {
    const client = {
      katalogReview: vi.fn(async () => {
        throw new RiskLayerHttpError(
          400,
          '/v1/katalog/review',
          JSON.stringify({ ok: false, fehler: 'Rückwärts-Übergang geprüft → entwurf ist nicht erlaubt' }),
        );
      }),
    };
    await expect(
      setKatalogReviewStatus(ctx, { begriffId: 'b1', status: 'entwurf' }, client as unknown as Client),
    ).rejects.toThrow('Rückwärts-Übergang geprüft → entwurf ist nicht erlaubt');
    expect(h.record).not.toHaveBeenCalled();
  });

  it('wirft CatalogReviewFailedError bei ok:false und auditiert NICHT', async () => {
    const client = { katalogReview: vi.fn(async () => ({ ok: false, fehler: 'kein geteilter Eintrag' })) };
    await expect(
      setKatalogReviewStatus(ctx, { begriffId: 'bX', status: 'freigegeben' }, client as unknown as Client),
    ).rejects.toBeInstanceOf(CatalogReviewFailedError);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('reicht Transportfehler (503) unverändert weiter — kein Audit', async () => {
    const client = {
      katalogReview: vi.fn(async () => {
        throw new RiskLayerHttpError(503, '/v1/katalog/review', '');
      }),
    };
    await expect(
      setKatalogReviewStatus(ctx, { begriffId: 'b1', status: 'geprüft' }, client as unknown as Client),
    ).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(h.record).not.toHaveBeenCalled();
  });
});
