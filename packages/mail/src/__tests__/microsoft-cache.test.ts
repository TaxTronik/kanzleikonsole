// Fachkatalog: MAIL-INBOX-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMailbox } from '@prisma/client';
type CacheEvent = { cacheHasChanged: boolean; tokenCache: { serialize(): string } };
const m = vi.hoisted(() => ({
  after: null as null | ((event: CacheEvent) => Promise<void>),
  system: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({ withSystemContext: m.system }));
vi.mock('@taxtronik/crypto', () => ({
  encryptSecret: (value: string) => 'encrypted:' + value,
  decryptSecret: (value: string) => value,
}));
vi.mock('@taxtronik/storage', () => ({
  scanBytes: vi.fn(),
  putObjectBytes: vi.fn(),
  getBucketForTier: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  detectMimeFromMagicBytes: vi.fn(),
}));
vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    constructor(config: { cache: { cachePlugin: { afterCacheAccess: typeof m.after } } }) {
      m.after = config.cache.cachePlugin.afterCacheAccess;
    }
  },
}));
import { microsoftClient } from '../imap';
const account = {
  id: 'mailbox',
  tenantId: 'tenant',
  entraTenantId: 'entra',
  entraClientId: 'client',
  secretEnc: 'client-secret',
} as InboundMailbox;
beforeEach(() => {
  vi.clearAllMocks();
  m.system.mockImplementation(async (_tenant, fn) => fn({ inboundMailbox: { update: m.update } }));
});
describe('Microsoft callback cache writer and worker refresh separation', () => {
  it('uses the callback writer without falling back to SYSTEM if fresh authorization fails', async () => {
    const writer = vi.fn(async () => {
      throw new Error('authorization changed');
    });
    microsoftClient(account, writer);
    await expect(
      m.after!({ cacheHasChanged: true, tokenCache: { serialize: () => 'token-cache' } }),
    ).rejects.toThrow('authorization changed');
    expect(writer).toHaveBeenCalledExactlyOnceWith('encrypted:token-cache');
    expect(m.system).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('retains encrypted SYSTEM persistence for background silent refreshes', async () => {
    microsoftClient(account);
    await m.after!({ cacheHasChanged: true, tokenCache: { serialize: () => 'token-cache' } });
    expect(m.system).toHaveBeenCalledOnce();
    expect(m.update).toHaveBeenCalledWith({
      where: { id: 'mailbox' },
      data: { oauthCacheEnc: 'encrypted:token-cache' },
    });
  });
});
