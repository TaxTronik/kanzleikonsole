// Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001
// B14 (P-17): GET /api/health/detail — die admin-gegatete Health-Ausgabe meldet
// den Rückstand der Wartungsjobs (`maintenance`). Ohne Sitzung 401, ohne
// ADMIN/PARTNER 403, beides ohne Statuslesen. Ein Rückstand ist kein
// Dienstausfall: HTTP-Code und `status` folgen weiter nur den Diensten.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: null as null | { user: { tenantId: string; staffId: string; roles: string[] } },
  maintenance: vi.fn(),
  postgresOk: true,
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => h.session }));
vi.mock('@/server/health/checks', () => ({
  checkPostgres: async () => ({ ok: h.postgresOk, latencyMs: 1 }),
  checkRedis: async () => ({ ok: true, latencyMs: 1 }),
  checkObjectStore: async () => ({ ok: true, latencyMs: 1 }),
  checkClamAV: async () => ({ ok: true, latencyMs: 1 }),
  checkSignalEngine: async () => null,
}));
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ signalEngine: false }),
}));
vi.mock('@/server/jobs/maintenance-backlog', () => ({
  getMaintenanceBacklogHealth: h.maintenance,
}));

import { GET } from '../route';

const MAINTENANCE = {
  status: 'alarm',
  jobs: [
    {
      queue: 'audit-rotate',
      readable: true,
      lastRunAt: '2026-10-04T03:12:00.000Z',
      backlog: 1_200,
      oldestPendingDueAt: '2026-09-28T03:00:00.000Z',
      oldestPendingAgeMs: 795_600_000,
      consecutiveRuns: 2,
      alarm: true,
      threshold: { consecutiveRuns: 3, maxOverdueMs: 604_800_000 },
    },
  ],
};

function session(roles: string[]) {
  return { user: { tenantId: 'tenant-1', staffId: 'staff-1', roles } };
}

beforeEach(() => {
  h.session = null;
  h.postgresOk = true;
  h.maintenance.mockReset();
  h.maintenance.mockResolvedValue(MAINTENANCE);
});

describe('GET /api/health/detail', () => {
  it('ohne Sitzung 401, ohne ADMIN/PARTNER 403 — der Rückstand wird dann nicht gelesen', async () => {
    expect((await GET()).status).toBe(401);
    h.session = session(['STAFF']);
    expect((await GET()).status).toBe(403);
    expect(h.maintenance).not.toHaveBeenCalled();
  });

  it.each([['ADMIN'], ['PARTNER']])(
    '%s erhält den Rückstand der Wartungsjobs; ein Alarm ändert den HTTP-Status nicht',
    async (role) => {
      h.session = session([role]);

      const res = await GET();

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'ok', maintenance: MAINTENANCE });
    },
  );

  it('ein Dienstausfall bleibt 503, der Rückstand steht trotzdem in der Antwort', async () => {
    h.session = session(['ADMIN']);
    h.postgresOk = false;

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded', maintenance: MAINTENANCE });
  });
});
