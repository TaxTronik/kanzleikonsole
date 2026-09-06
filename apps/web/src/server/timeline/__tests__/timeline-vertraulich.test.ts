import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Timeline × vertrauliche Subsumtion: Der Titel ist Inhalt. Unbeteiligte sehen
// das Ereignis („Subsumtion analysiert"), aber einen neutralen Titel — die
// Chronik verschweigt nichts, verraet aber auch nichts.
// =============================================================================

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  canStaffWriteClientTx: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({ canStaffWriteClientTx: m.canStaffWriteClientTx }));

import type { TenantContext } from '@taxtronik/db';
import { buildClientTimeline } from '../build';

const CTX: TenantContext = {
  tenantId: 'aaaaaaaa-1111-4111-8111-111111111111',
  actorId: 'bbbbbbbb-2222-4222-8222-222222222222',
  actorType: 'STAFF',
};

/** Stub: alle Quellen leer bis auf die Risiko-Analysen. */
function mockTx(input: {
  analyses: Array<{
    id: string;
    title: string | null;
    vertraulich: boolean;
    archivedAt?: Date;
  }>;
  assignedAnalysisIds?: string[];
}) {
  const leer = { findMany: vi.fn().mockResolvedValue([]) };
  const tx = {
    document: leer,
    request: leer,
    requestResponse: leer,
    phoneNote: leer,
    invoice: leer,
    gwgCheck: leer,
    powerOfAttorney: leer,
    taxNotice: leer,
    taxDeadline: leer,
    workflowItem: leer,
    riskAnalysis: {
      findMany: vi.fn().mockResolvedValue(
        input.analyses.map((a) => ({
          ...a,
          textHash: 'hash',
          katalogVersion: 'v1',
          createdAt: new Date('2026-08-01T10:00:00Z'),
          archivedAt: a.archivedAt ?? null,
          _count: { markings: 1 },
        })),
      ),
    },
    riskMarking: {
      findMany: vi
        .fn()
        .mockResolvedValue((input.assignedAnalysisIds ?? []).map((id) => ({ analysisId: id }))),
    },
  };
  m.withTenantContext.mockImplementation((_c: TenantContext, cb: (t: unknown) => unknown) =>
    cb(tx),
  );
  return tx;
}

const CLIENT = 'cccccccc-3333-4333-8333-333333333333';

beforeEach(() => vi.clearAllMocks());

describe('buildClientTimeline × vertrauliche Subsumtion', () => {
  it('neutralisiert den Titel für Unbeteiligte', async () => {
    mockTx({ analyses: [{ id: 'ra1', title: 'Selbstanzeige GF', vertraulich: true }] });
    m.canStaffWriteClientTx.mockResolvedValue(false);

    const events = await buildClientTimeline(CTX, { clientId: CLIENT });
    const ra = events.find((e) => e.id === 'ra:ra1')!;
    expect(ra.title).toBe('Subsumtion analysiert (vertraulich)');
    expect(JSON.stringify(events)).not.toContain('Selbstanzeige');
  });

  it('zeigt der vollen Stufe und Zugewiesenen den echten Titel', async () => {
    mockTx({ analyses: [{ id: 'ra1', title: 'Selbstanzeige GF', vertraulich: true }] });
    m.canStaffWriteClientTx.mockResolvedValue(true);
    const voll = await buildClientTimeline(CTX, { clientId: CLIENT });
    expect(voll.find((e) => e.id === 'ra:ra1')!.title).toContain('Selbstanzeige GF');

    mockTx({
      analyses: [{ id: 'ra1', title: 'Selbstanzeige GF', vertraulich: true }],
      assignedAnalysisIds: ['ra1'],
    });
    m.canStaffWriteClientTx.mockResolvedValue(false);
    const zugewiesen = await buildClientTimeline(CTX, { clientId: CLIENT });
    expect(zugewiesen.find((e) => e.id === 'ra:ra1')!.title).toContain('Selbstanzeige GF');
  });

  it('lässt nicht-vertrauliche Titel unangetastet — ohne jede Rechte-Query', async () => {
    mockTx({ analyses: [{ id: 'ra1', title: 'Kassenführung 2025', vertraulich: false }] });

    const events = await buildClientTimeline(CTX, { clientId: CLIENT });
    expect(events.find((e) => e.id === 'ra:ra1')!.title).toContain('Kassenführung 2025');
    expect(m.canStaffWriteClientTx).not.toHaveBeenCalled();
  });

  it('ACCESS-TENANT-RLS-001: neutralisiert auch den jüngsten Archivstand ohne Akteur', async () => {
    const tx = mockTx({
      analyses: [
        {
          id: 'ra1',
          title: 'Selbstanzeige GF',
          vertraulich: true,
          archivedAt: new Date('2026-09-01T10:00:00Z'),
        },
      ],
    });
    const events = await buildClientTimeline(
      { ...CTX, actorId: null },
      { clientId: CLIENT, limit: 1 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'ra-arch:ra1',
      title: 'Subsumtion revisionssicher archiviert (vertraulich)',
    });
    expect(JSON.stringify(events)).not.toContain('Selbstanzeige');
    expect(m.canStaffWriteClientTx).not.toHaveBeenCalled();
    expect(tx.riskMarking.findMany).not.toHaveBeenCalled();
  });
});
