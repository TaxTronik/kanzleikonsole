import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getRedisMock, setMock, evalMock } = vi.hoisted(() => ({
  getRedisMock: vi.fn(),
  setMock: vi.fn(),
  evalMock: vi.fn(),
}));

vi.mock('@/server/redis', () => ({ getRedis: getRedisMock }));
vi.mock('@/server/logger', () => ({ log: { warn: vi.fn() } }));

import { releaseNonce, reserveNonce } from '../nonce-store';

beforeEach(() => {
  vi.clearAllMocks();
  setMock.mockResolvedValue('OK');
  evalMock.mockResolvedValue(1);
  getRedisMock.mockReturnValue({ set: setMock, eval: evalMock });
});

describe('Legacy-n8n-Nonce-Store', () => {
  it('reserviert atomar mit einer eindeutigen Owner-ID', async () => {
    const reservation = await reserveNonce('sha256=signature');

    expect(reservation).toEqual({
      key: 'n8n-nonce:sha256=signature',
      owner: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    if (!reservation) throw new Error('Reservation fehlt');
    expect(setMock).toHaveBeenCalledWith(reservation.key, reservation.owner, 'EX', 600, 'NX');
  });

  it('meldet parallele Duplikate und Redis-Ausfälle fail-closed', async () => {
    setMock.mockResolvedValueOnce(null);
    expect(await reserveNonce('sha256=duplicate')).toBe(false);

    getRedisMock.mockReturnValueOnce(null);
    expect(await reserveNonce('sha256=unavailable')).toBeNull();
  });

  it('gibt nur die eigene Reservation per compare-and-delete frei', async () => {
    const reservation = { key: 'n8n-nonce:test', owner: 'owner-1' };

    expect(await releaseNonce(reservation)).toBe(true);
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      reservation.key,
      reservation.owner,
    );
  });
});
