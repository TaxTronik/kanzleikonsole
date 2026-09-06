// Fachkatalog: MAIL-INBOX-001
import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { persistMicrosoftOauthCacheTx } from '../oauth-cache';

const makeTx = (enabled = true, admin = true) => ({
  $queryRaw: vi
    .fn()
    .mockResolvedValueOnce([{ value: { smartMailbox: enabled } }])
    .mockResolvedValueOnce(admin ? [{ id: 'staff' }] : []),
  inboundMailbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
});
describe('OAuth credential persistence after external token exchange', () => {
  it('refuses a role revoked while the token request was pending', async () => {
    const tx = makeTx(true, false);
    await expect(
      persistMicrosoftOauthCacheTx(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'mailbox',
        'encrypted-cache',
      ),
    ).rejects.toThrow('authorization changed');
    expect(tx.inboundMailbox.updateMany).not.toHaveBeenCalled();
  });
  it('refuses a module disabled while the token request was pending', async () => {
    const tx = makeTx(false);
    await expect(
      persistMicrosoftOauthCacheTx(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'mailbox',
        'encrypted-cache',
      ),
    ).rejects.toThrow('authorization changed');
    expect(tx.inboundMailbox.updateMany).not.toHaveBeenCalled();
  });
  it('writes encrypted credentials once under current admin and module locks', async () => {
    const tx = makeTx();
    await persistMicrosoftOauthCacheTx(
      tx as unknown as TxClient,
      'tenant',
      'staff',
      'mailbox',
      'encrypted-cache',
    );
    expect(tx.$queryRaw.mock.calls.every(([sql]) => sql.join('').includes('FOR SHARE'))).toBe(true);
    expect(tx.inboundMailbox.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'mailbox', tenantId: 'tenant', provider: 'MICROSOFT365' },
      data: { oauthCacheEnc: 'encrypted-cache', lastError: null },
    });
  });
});
