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
  sizeBytes: number;
};
type DocType = { id: string; tier: string; classificationKey: string; retentionYears: null };
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  tx: null as unknown as ReturnType<typeof makeTx>,
  enabled: true,
  finish: vi.fn(),
  persist: vi.fn<(options: ResumableDocumentUploadOptions) => Promise<void>>(),
  audit: vi.fn(),
  fetchBytes: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
    fn(m.tx),
}));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: async () => ({ smartMailbox: m.enabled }),
}));
vi.mock('@/server/actions/staff-action', async () => {
  const staffActionGuard = async () => ({
    ok: true as const,
    tenantId: 'tenant',
    staffId: 'staff',
    ctx: {},
    session: {},
  });
  return {
    ActionError: (await import('@/server/actions/action-error')).ActionError,
    staffActionGuard,
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: (
      await vi.importActual<typeof import('@/server/actions/action-runner')>(
        '@/server/actions/action-runner',
      )
    ).createActionRunner(staffActionGuard),
  };
});
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: async () => undefined,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.audit } }));
vi.mock('@/server/documents/resumable-upload', () => ({
  persistResumableDocumentUpload: m.persist,
}));
vi.mock('@taxtronik/mail/imap', () => ({ microsoftClient: vi.fn(), IMAP_SCOPES: [] }));
vi.mock('@taxtronik/crypto', async () => ({
  ...(await import('@taxtronik/crypto/secret-slots')),
  encryptSecret: vi.fn(),
}));
vi.mock('@taxtronik/config', () => ({ env: {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@taxtronik/storage', async () => ({
  fetchVerifiedObjectBytes: m.fetchBytes,
  getBucketForTier: (tier: string) => `bucket-${tier.toLowerCase()}`,
  StoredObjectError: (await import('@taxtronik/storage/errors')).StoredObjectError,
}));
import { StoredObjectError } from '@taxtronik/storage/errors';
import {
  importAttachment,
  saveMailbox,
  setMailboxEnabled,
} from '@/app/staff/(protected)/mailbox/actions';
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
    inboundMailbox: {
      create: vi.fn(async () => ({ id: uuid })),
      findFirst: vi.fn(async () => null),
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
    sizeBytes: 11,
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
    await expect(importAttachment(null, form())).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Modul deaktiviert'),
    });
    expect(m.tx.inboundAttachment.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('rechecks the active mandate and type before marking an import complete', async () => {
    m.finish.mockImplementationOnce(() => {
      m.tx.documentType.findFirst.mockResolvedValue(null);
    });
    await expect(importAttachment(null, form())).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Dokumenttyp'),
    });
    expect(m.tx.inboundAttachment.update).not.toHaveBeenCalled();
  });
  it('binds a single private archive without automatic portal sharing', async () => {
    await expect(importAttachment(null, form())).resolves.toEqual({ ok: true });
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
    await expect(importAttachment(null, form())).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Ablagetyp'),
    });
    expect(m.persist).not.toHaveBeenCalled();
  });
  it('meldet ungültige Zuordnungsdaten mit Feldzuordnung, ohne zu archivieren (F-01)', async () => {
    const f = form();
    f.set('documentTypeId', 'keine-uuid');

    await expect(importAttachment(null, f)).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { documentTypeId: [expect.any(String)] },
    });
    expect(m.persist).not.toHaveBeenCalled();
  });
});
// R-05: Der Import liest die Anhangbytes über den gemeinsamen, immer prüfenden
// Leseweg (Größe und SHA-256 des geprüften Anhangs); die Prüfung selbst belegt
// packages/storage (verified-read.test.ts).
describe('Anhangbytes für das Archiv (R-05)', () => {
  async function captureReadBytes(): Promise<() => Promise<Buffer>> {
    let readBytes: (() => Promise<Buffer>) | undefined;
    m.persist.mockImplementationOnce(async (options) => {
      readBytes = options.readBytes;
    });
    await expect(importAttachment(null, form())).resolves.toEqual({ ok: true });
    return readBytes!;
  }

  it('liest den Anhang gegen Größe und SHA-256 des geprüften Anhangs', async () => {
    const bytes = Buffer.from('receipt pdf');
    m.fetchBytes.mockResolvedValue(bytes);
    const readBytes = await captureReadBytes();

    await expect(readBytes()).resolves.toBe(bytes);
    expect(m.fetchBytes).toHaveBeenCalledExactlyOnceWith(
      { bucket: 'bucket-none', key: 'source' },
      { sizeBytes: 11, sha256: 'a'.repeat(64) },
    );
  });

  it.each(['HASH_MISMATCH', 'SIZE_MISMATCH', 'LENGTH_MISMATCH'] as const)(
    'weist abweichende Bytes (%s) mit der bisherigen Meldung ab',
    async (reason) => {
      m.fetchBytes.mockRejectedValue(new StoredObjectError(reason, 'weicht ab'));
      const readBytes = await captureReadBytes();

      await expect(readBytes()).rejects.toMatchObject({
        name: 'ActionError',
        message: 'Anhang-Prüfsumme stimmt nicht.',
      });
    },
  );

  it('reicht Speicher- und Limitfehler unverändert weiter', async () => {
    m.fetchBytes.mockRejectedValue(new StoredObjectError('MISSING_BODY', 'leer'));
    const readBytes = await captureReadBytes();

    await expect(readBytes()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'MISSING_BODY',
    });
  });
});
describe('Postfach-Verwaltung — Rückkanal (Review-Befund F-01)', () => {
  it('meldet unvollständige Postfachdaten mit Feldzuordnung, ohne etwas anzulegen', async () => {
    const f = new FormData();
    f.set('name', '');
    f.set('provider', 'IMAP');

    await expect(saveMailbox(null, f)).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { name: [expect.any(String)] },
    });
    expect(m.tx.inboundMailbox.create).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it('meldet ein unbekanntes Postfach beim Aktivieren, statt in error.tsx zu enden', async () => {
    const f = new FormData();
    f.set('id', uuid);
    f.set('enabled', 'true');

    await expect(setMailboxEnabled(null, f)).resolves.toEqual({
      ok: false,
      error: 'Postfach nicht gefunden.',
    });
    expect(m.tx.inboundMailbox.update).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});
