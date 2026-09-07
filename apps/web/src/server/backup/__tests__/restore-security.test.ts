// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001.
import { describe, expect, it, vi } from 'vitest';
import { assertRestoreTargetSecurity } from '@taxtronik/db/restore-security';

describe('Restore security probe failures', () => {
  it.each([{ rows: [] }, { rows: [{ aclState: null }] }, { rows: [{ aclState: 'true' }] }])(
    'rejects incomplete privilege evidence without announcing rollback: %j',
    async ({ rows }) => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      await expect(
        assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
          $queryRaw: vi.fn().mockResolvedValue(rows),
          $disconnect: disconnect,
        })),
      ).rejects.toThrow('bereits angewendet und nicht zurückgerollt');
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it('does not announce success when PostgreSQL cannot verify the restored state', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
        $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')),
        $disconnect: disconnect,
      })),
    ).rejects.toThrow('Dienste nicht starten');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
