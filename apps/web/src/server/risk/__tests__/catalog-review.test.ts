// Fachkatalog: RISK-CATALOG-FOUR-EYES-001
import { describe, it, expect, vi, beforeEach } from 'vitest';

// @taxtronik/db (Barrel) verlangt DATABASE_URL beim Import + macht echte Tx →
// mocken. evidenceService ist ein Spy. Der Paket-Mock liefert RiskLayerHttpError
// als echte Klasse, weil catalog-review.ts per instanceof darauf prüft.
// `definedBy` simuliert den risk.catalog.defined-Eintrag der Audit-Chain
// (Vier-Augen-Quelle): null = kein bekannter Autor.
const h = vi.hoisted(() => ({
  record: vi.fn(),
  definedBy: null as { actorId: string | null } | null,
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ auditLog: { findFirst: async () => h.definedBy } }),
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
import {
  setKatalogReviewStatus,
  CatalogReviewFailedError,
  riskReviewActorTag,
  reviewableCatalogMarkingIds,
} from '../catalog-review';

type Ctx = Parameters<typeof setKatalogReviewStatus>[0];
type Client = Parameters<typeof setKatalogReviewStatus>[2];
const ctx = { tenantId: 't1', actorId: 's1', actorType: 'STAFF' } as unknown as Ctx;

beforeEach(() => {
  h.record.mockReset();
  h.definedBy = null;
});

describe('setKatalogReviewStatus', () => {
  it('zeigt Katalog-Review nur fuer den aktuellen geteilten Berater-Eintrag', () => {
    const result = reviewableCatalogMarkingIds(
      [
        { id: 'built-in', begriffId: 'ao_schaetzung' },
        { id: 'shared', begriffId: 'berater_shared' },
        { id: 'personal', begriffId: 'berater_personal' },
        { id: 'stale', begriffId: 'berater_neu' },
      ],
      [
        {
          resourceId: 'shared',
          after: { begriffId: 'berater_shared', scope: 'geteilt' },
        },
        {
          resourceId: 'personal',
          after: { begriffId: 'berater_personal', scope: 'personal' },
        },
        {
          resourceId: 'stale',
          after: { begriffId: 'berater_alt', scope: 'geteilt' },
        },
      ],
    );
    expect([...result]).toEqual(['shared']);
  });

  it('erzeugt ein stabiles, mandantengebundenes und PII-freies Actor-Tag', () => {
    const tag = riskReviewActorTag('t1', 's1');
    expect(tag).toMatch(/^tt_staff_[a-p]{32}$/);
    expect(riskReviewActorTag('t1', 's1')).toBe(tag);
    expect(riskReviewActorTag('t2', 's1')).not.toBe(tag);
    expect(riskReviewActorTag('t1', 's2')).not.toBe(tag);
  });

  it('sendet ein Actor-Tag an die Engine und verankert lokal den echten Actor', async () => {
    const prueferTag = riskReviewActorTag('t1', 's1');
    const client = {
      katalogReview: vi.fn(async () => ({
        ok: true,
        id: 'b1',
        alter_status: 'entwurf',
        neuer_status: 'geprüft',
        pruefer: prueferTag,
      })),
    };
    const res = await setKatalogReviewStatus(
      ctx,
      { begriffId: 'b1', status: 'geprüft' },
      client as unknown as Client,
    );

    expect(client.katalogReview).toHaveBeenCalledWith({
      id: 'b1',
      status: 'geprüft',
      pruefer: prueferTag,
    });
    expect(res).toEqual({ alterStatus: 'entwurf', neuerStatus: 'geprüft' });
    expect(h.record).toHaveBeenCalledTimes(1);
    const ev = h.record.mock.calls[0]![1] as {
      action: string;
      resourceId: string;
      before: unknown;
      after: unknown;
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
          JSON.stringify({
            ok: false,
            fehler: 'Rückwärts-Übergang geprüft → entwurf ist nicht erlaubt',
          }),
        );
      }),
    };
    await expect(
      setKatalogReviewStatus(
        ctx,
        { begriffId: 'b1', status: 'entwurf' },
        client as unknown as Client,
      ),
    ).rejects.toThrow('Rückwärts-Übergang geprüft → entwurf ist nicht erlaubt');
    expect(h.record).not.toHaveBeenCalled();
  });

  it('übersetzt einen 422-Geheimnisschutzfehler in einen UI-tauglichen Domänenfehler', async () => {
    const client = {
      katalogReview: vi.fn(async () => {
        throw new RiskLayerHttpError(
          422,
          '/v1/katalog/review',
          JSON.stringify({ error: 'Actor-Tag wurde vom Geheimnisschutz abgelehnt.' }),
        );
      }),
    };
    await expect(
      setKatalogReviewStatus(
        ctx,
        { begriffId: 'b1', status: 'geprüft' },
        client as unknown as Client,
      ),
    ).rejects.toThrow('Actor-Tag wurde vom Geheimnisschutz abgelehnt.');
    expect(h.record).not.toHaveBeenCalled();
  });

  it('wirft CatalogReviewFailedError bei ok:false und auditiert NICHT', async () => {
    const client = {
      katalogReview: vi.fn(async () => ({ ok: false, fehler: 'kein geteilter Eintrag' })),
    };
    await expect(
      setKatalogReviewStatus(
        ctx,
        { begriffId: 'bX', status: 'freigegeben' },
        client as unknown as Client,
      ),
    ).rejects.toBeInstanceOf(CatalogReviewFailedError);
    expect(h.record).not.toHaveBeenCalled();
  });

  it('Vier-Augen: der Autor des Begriffs wird geblockt — kein Engine-Call, kein Audit', async () => {
    h.definedBy = { actorId: 's1' }; // = ctx.actorId
    const client = { katalogReview: vi.fn() };
    await expect(
      setKatalogReviewStatus(
        ctx,
        { begriffId: 'b1', status: 'freigegeben' },
        client as unknown as Client,
      ),
    ).rejects.toThrow('Vier-Augen-Prinzip');
    expect(client.katalogReview).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('Vier-Augen: eine ZWEITE Person darf freigeben', async () => {
    h.definedBy = { actorId: 'jemand-anderes' };
    const client = {
      katalogReview: vi.fn(async () => ({
        ok: true,
        id: 'b1',
        alter_status: 'geprüft',
        neuer_status: 'freigegeben',
        pruefer: 's1',
      })),
    };
    const res = await setKatalogReviewStatus(
      ctx,
      { begriffId: 'b1', status: 'freigegeben' },
      client as unknown as Client,
    );
    expect(res.neuerStatus).toBe('freigegeben');
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('reicht Transportfehler (503) unverändert weiter — kein Audit', async () => {
    const client = {
      katalogReview: vi.fn(async () => {
        throw new RiskLayerHttpError(503, '/v1/katalog/review', '');
      }),
    };
    await expect(
      setKatalogReviewStatus(
        ctx,
        { begriffId: 'b1', status: 'geprüft' },
        client as unknown as Client,
      ),
    ).rejects.toBeInstanceOf(RiskLayerHttpError);
    expect(h.record).not.toHaveBeenCalled();
  });
});
