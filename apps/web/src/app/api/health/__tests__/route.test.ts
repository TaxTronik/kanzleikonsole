// N3 / B14: Die öffentliche Health-Route (Reverse-Proxy, Docker-HEALTHCHECK,
// externer Uptime-Check) liefert nur den binären Dienststatus. Der Rückstand
// der Wartungsjobs steht ausschließlich in der admin-gegateten
// /api/health/detail und beeinflusst den Status hier nicht.
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ maintenance: vi.fn() }));

vi.mock('@/server/health/checks', () => ({
  checkPostgres: async () => ({ ok: true, latencyMs: 1 }),
  checkRedis: async () => ({ ok: true, latencyMs: 1 }),
  checkObjectStore: async () => ({ ok: true, latencyMs: 1 }),
  checkClamAV: async () => ({ ok: true, latencyMs: 1 }),
}));
vi.mock('@/server/jobs/maintenance-backlog', () => ({
  getMaintenanceBacklogHealth: h.maintenance,
}));

import { GET } from '../route';

describe('GET /api/health', () => {
  it('liefert nur Status und Zeitstempel, ohne Wartungsrückstand', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['status', 'timestamp']);
    expect(body['status']).toBe('ok');
    expect(h.maintenance).not.toHaveBeenCalled();
  });
});
