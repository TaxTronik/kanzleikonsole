// F-05: Ein gescheitertes Zurücksetzen eines Rate-Limit-Zählers wird geloggt —
// ohne IP, E-Mail oder Konto aus dem Schlüssel.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  del: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('@/server/redis', () => ({ getRedis: () => ({ del: h.del }) }));
vi.mock('@/server/logger', () => ({ log: { warn: h.logWarn, error: vi.fn() } }));

import { resetRateLimit } from '../index';

beforeEach(() => {
  h.del.mockReset();
  h.logWarn.mockReset();
});

describe('F-05 resetRateLimit', () => {
  it('setzt den Zähler zurück', async () => {
    h.del.mockResolvedValue(1);
    await resetRateLimit('staff-authorize:203.0.113.7');
    expect(h.del).toHaveBeenCalledWith('rl:staff-authorize:203.0.113.7');
    expect(h.logWarn).not.toHaveBeenCalled();
  });

  it('loggt einen Redis-Fehler nur mit der Art des Schlüssels', async () => {
    h.del.mockRejectedValue(new Error('redis down'));
    await expect(resetRateLimit('staff-authorize:203.0.113.7')).resolves.toBeUndefined();
    expect(h.logWarn).toHaveBeenCalledExactlyOnceWith(
      { component: 'rate-limit', keyKind: 'staff-authorize', err: 'redis down' },
      'rate-limit: Zurücksetzen fehlgeschlagen',
    );
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain('203.0.113.7');
  });
});
