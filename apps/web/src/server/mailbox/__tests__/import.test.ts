// Fachkatalog: MAIL-INBOX-001, DOC-UPLOAD-JOURNAL-001
import type { ResumableDocumentUploadOptions } from '@/server/documents/resumable-upload';
import type { TxClient } from '@taxtronik/db';
type Attachment = {
  id: string;
  documentId: string | null;
  storageKey: string;
  status: string;
  filename: string;
  mimeType: string;
  sha256: string;
};
type DocType = { id: string; tier: string; classificationKey: string; retentionYears: null };
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  tx: null as unknown as ReturnType<typeof makeTx>,
  enabled: true,
  finish: vi.fn(),
  persist: vi.fn<(options: ResumableDocumentUploadOptions) => Promise<void>>(),
  audit: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
    fn(m.tx),
}));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: async () => ({ smartMailbox: m.enabled }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    tenantId: 'tenant',
    staffId: 'staff',
    ctx: {},
    session: {},
  }),
  ActionError: class extends Error {},
}));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: async () => undefined }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.audit } }));
vi.mock('@/server/documents/resumable-upload', () => ({
  persistResumableDocumentUpload: m.persist,
}));
vi.mock('@taxtronik/mail/imap', () => ({ microsoftClient: vi.fn(), IMAP_SCOPES: [] }));
vi.mock('@taxtronik/crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ env: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ fetchObjectBytes: vi.fn(), getBucketForTier: vi.fn() }));
import { importAttachment } from '@/app/staff/(protected)/mailbox/actions';
const uuid = '11111111-1111-4111-8111-111111111111';
let attachment: Attachment;
let type: DocType;
function makeTx() {
  return {
    client: { findFirst: vi.fn(async () => ({ id: uuid })) },
    documentType: {
      findFirst: vi.fn<() => Promise<DocType | null>>().mockImplementation(async () => type),
    },
    inboundAttachment: {
      findFirst: vi.fn(async () => attachment),
      updateMany: vi.fn(async ({ data }: { data: Partial<Attachment> }) => {
        Object.assign(attachment, data);
        return { count: 1 };
      }),
      update: vi.fn(async () => undefined),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.enabled = true;
  attachment = {
    id: uuid,
    documentId: null,
    storageKey: 'source',
    status: 'CLEAN',
    filename: 'receipt.pdf',
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
  };
  type = { id: uuid, tier: 'NONE', classificationKey: 'GENERAL', retentionYears: null };
  m.tx = makeTx();
  m.persist.mockImplementation(async (options) => {
    await options.guardMutationTx(m.tx as unknown as TxClient);
    await options.recordPendingTx?.(m.tx as unknown as TxClient, {
      documentId: 'output',
      versionId: 'version',
    });
    await m.finish();
    await options.recordCompleteTx?.(m.tx as unknown as TxClient, {
      documentId: 'output',
      versionId: 'version',
    });
  });
});
function form() {
  const f = new FormData();
  for (const key of ['id', 'clientId', 'documentTypeId']) f.set(key, uuid);
  return f;
}
describe('mail archive completion after object-store I/O', () => {
  it('rechecks module activation and does not finalize an interrupted import', async () => {
    m.finish.mockImplementationOnce(() => {
      m.enabled = false;
    });
    await expect(importAttachment(form())).rejects.toThrow('Modul deaktiviert');
    expect(m.tx.inboundAttachment.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('rechecks the active mandate and type before marking an import complete', async () => {
    m.finish.mockImplementationOnce(() => {
      m.tx.documentType.findFirst.mockResolvedValue(null);
    });
    await expect(importAttachment(form())).rejects.toThrow('Dokumenttyp');
    expect(m.tx.inboundAttachment.update).not.toHaveBeenCalled();
  });
  it('binds a single private archive without automatic portal sharing', async () => {
    await importAttachment(form());
    expect(m.persist.mock.calls[0]![0].documentData.sharedWithClientAt).toBeUndefined();
    expect(m.persist.mock.calls[0]![0].resumeWhere.sharedWithClientAt).toBeNull();
    expect(m.audit).toHaveBeenCalledWith(
      m.tx,
      expect.objectContaining({
        after: expect.objectContaining({
          sharedWithClient: false,
          sourceSha256: attachment.sha256,
        }),
      }),
    );
  });
  it('rejects personnel material through the general mailbox archive path', async () => {
    type.classificationKey = 'PERSONNEL';
    await expect(importAttachment(form())).rejects.toThrow('Ablagetyp');
    expect(m.persist).not.toHaveBeenCalled();
  });
});
