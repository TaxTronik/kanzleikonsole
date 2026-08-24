// Fachkatalog: RISK-ARCHIVE-SNAPSHOT-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Guard-Konsolidierung: EIN withTenantContext pro Guard.
//
// Vorher oeffnete jeder Guard-Schritt (Ressource laden, Zugriff, Rechtestufe,
// Ziel-Check) seine eigene Tenant-Transaktion — eine Write-Action kam auf
// drei bis vier, die Ergebnis-Pruefung auf fuenf. Diese Tests zaehlen die
// Transaktionen und pruefen, dass die Entscheidungen dabei identisch blieben.
// =============================================================================

const m = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  return {
    withTenantContext: vi.fn(),
    canAccessClientTx: vi.fn(),
    loadSubsumtionRights: vi.fn(),
    requireStaffSession: vi.fn(),
    ForbiddenError,
  };
});

vi.mock('@/server/auth/rbac', () => ({
  ForbiddenError: m.ForbiddenError,
  requireStaffSession: m.requireStaffSession,
  canAccessClientTx: m.canAccessClientTx,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/settings/modules', () => ({
  readModules: vi.fn().mockResolvedValue({ risk: true }),
}));
vi.mock('@taxtronik/risk-layer', () => ({ isRiskLayerConfigured: () => true }));
vi.mock('@/server/risk/rights', async () => {
  // Entscheidungsregeln ECHT (reines lib-Modul), nur der DB-Loader gemockt —
  // der Test soll die Regel-Auswertung mitpruefen, nicht ersetzen.
  const pure =
    await vi.importActual<typeof import('@/lib/subsumtion-rights')>('@/lib/subsumtion-rights');
  return { ...pure, loadSubsumtionRights: m.loadSubsumtionRights };
});

import {
  guardWrite,
  guardMarking,
  guardMarkingWrite,
  guardResultReview,
  guardResearch,
  guardAnalysisVertraulich,
} from '../_guards';

const SESSION = {
  user: { tenantId: 't1', staffId: 's1', fullName: 'Test', email: 't@t' },
};

const ANALYSIS = { id: 'an1', clientId: 'c1', archivedAt: null };

function mockTx(over: Record<string, unknown> = {}) {
  return {
    riskAnalysis: {
      findUnique: vi.fn().mockResolvedValue({ clientId: 'c1', archivedAt: null, ...over }),
    },
    riskMarking: {
      findUnique: vi.fn().mockResolvedValue({ analysis: ANALYSIS, analysisId: 'an1' }),
    },
    riskResearchResult: {
      findUnique: vi.fn().mockResolvedValue({
        markingId: 'm1',
        request: null,
        marking: { analysis: ANALYSIS },
      }),
    },
    ...over,
  };
}

let tx: ReturnType<typeof mockTx>;

beforeEach(() => {
  vi.clearAllMocks();
  tx = mockTx();
  m.requireStaffSession.mockResolvedValue(SESSION);
  m.canAccessClientTx.mockResolvedValue(true);
  m.loadSubsumtionRights.mockResolvedValue({ canWrite: true, assignedMarkingIds: [] });
  m.withTenantContext.mockImplementation((_ctx: unknown, cb: (t: unknown) => unknown) => cb(tx));
});

describe('Guards oeffnen genau EINE Tenant-Transaktion', () => {
  it('guardWrite: Zugriff + Schreibrecht in einer Tx', async () => {
    await guardWrite('c1');
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(m.canAccessClientTx).toHaveBeenCalledWith(tx, SESSION, 'c1');
    expect(m.loadSubsumtionRights).toHaveBeenCalledTimes(1);
  });

  it('guardMarkingWrite: Ressource + Zugriff + Recht in einer Tx', async () => {
    const r = await guardMarkingWrite('m1');
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(r.clientId).toBe('c1');
    expect(r.analysisId).toBe('an1');
  });

  it('guardResultReview: komplette Pruefkette in einer Tx', async () => {
    const r = await guardResultReview('r1', 'm1', 'verwerfen');
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
    expect(r.analysisId).toBe('an1');
    // Ziel-Check lief mit (Markierung derselben Analyse).
    expect(tx.riskMarking.findUnique).toHaveBeenCalled();
  });

  it('guardAnalysisVertraulich: laesst archivierte Analysen zu (eigene Regel)', async () => {
    tx.riskAnalysis.findUnique.mockResolvedValue({
      clientId: 'c1',
      vertraulich: true,
      archivedAt: new Date(),
    });
    const r = await guardAnalysisVertraulich('an1');
    expect(r.vertraulich).toBe(true);
    expect(m.withTenantContext).toHaveBeenCalledTimes(1);
  });
});

describe('Entscheidungen unveraendert', () => {
  it('ohne Schreibrecht: guardMarkingWrite lehnt ab, guardMarking (lesen) nicht', async () => {
    m.loadSubsumtionRights.mockResolvedValue({ canWrite: false, assignedMarkingIds: ['m1'] });
    await expect(guardMarkingWrite('m1')).rejects.toThrow(/Berufsträger/);
    await expect(guardMarking('m1')).resolves.toMatchObject({ clientId: 'c1' });
  });

  it('guardResultReview bindet ans Ergebnis: fremdes Ergebnis wird abgelehnt', async () => {
    m.loadSubsumtionRights.mockResolvedValue({ canWrite: false, assignedMarkingIds: ['m1'] });
    // Ergebnis haengt an FREMDER Markierung — eigene markingId als Feigenblatt.
    tx.riskResearchResult.findUnique.mockResolvedValue({
      markingId: 'fremd',
      request: null,
      marking: { analysis: ANALYSIS },
    });
    await expect(guardResultReview('r1', 'm1', 'verwerfen')).rejects.toThrow(
      /gehört nicht zu deiner Markierung/,
    );
  });

  it('guardResultReview: Ziel-Markierung fremder Analyse wird abgelehnt', async () => {
    tx.riskMarking.findUnique.mockResolvedValue({ analysisId: 'andere-analyse' });
    await expect(guardResultReview('r1', 'm1', 'uebernehmen')).rejects.toThrow(
      /gehört nicht zu dieser Analyse/,
    );
  });

  it('guardResearch: full-Sachverhalt bleibt der vollen Stufe vorbehalten', async () => {
    m.loadSubsumtionRights.mockResolvedValue({ canWrite: false, assignedMarkingIds: ['m1'] });
    await expect(
      guardResearch({ analysisId: 'an1', markingId: 'm1', sachverhalt: 'full' }),
    ).rejects.toThrow(/gesamte Sachverhalt/);
    await expect(
      guardResearch({ analysisId: 'an1', markingId: 'm1', sachverhalt: 'excerpt' }),
    ).resolves.toMatchObject({ scope: { volleAkteneinsicht: false } });
    expect(m.withTenantContext).toHaveBeenCalledTimes(2); // je Aufruf eine
  });

  it('kein Mandantenzugriff → Ablehnung vor jeder Rechte-Query', async () => {
    m.canAccessClientTx.mockResolvedValue(false);
    await expect(guardMarking('m1')).rejects.toThrow(/Kein Zugriff/);
    expect(m.loadSubsumtionRights).not.toHaveBeenCalled();
  });
});
