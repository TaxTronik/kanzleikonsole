// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: DOC-PORTAL-SHARING-001
import { beforeEach, describe, it, expect, vi } from 'vitest';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const mocks = vi.hoisted(() => ({
  tx: {} as Record<string, unknown>,
  guard: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx),
}));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: mocks.guard }));
vi.mock('@/server/actions/portal-action', () => ({ portalActionGuard: mocks.guard }));
vi.mock('@/server/auth/rbac', () => ({
  ActionError: class extends Error {},
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.audit } }));
vi.mock('@/server/rate-limit', () => ({
  checkPortalWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
import { reimportAssistance, saveAssistance, reviewAssistance } from '../service';
function fixture() {
  const current = {
    id: a,
    clientId: a,
    tenantId: a,
    title: 'Verfahren',
    kind: 'PROCEDURE',
    revision: 2,
    status: 'REVIEWED',
    answers: { organization: 'Alte Strukturantwort' },
    schemaSnapshot: {
      title: 'Verfahren',
      version: 1,
      fields: [{ key: 'organization', label: 'Organisation', type: 'textarea' }],
    },
    sourceDocumentVersionId: null,
    sourceHash: null,
    externalDocumentVersionId: null,
    externalDocumentHash: null,
    confirmedAt: null,
    reviewNote: 'Vorige Prüfung',
    reviewedByStaff: b,
    submittedByContact: null,
  };
  const db = {
    client: { findFirst: vi.fn().mockResolvedValue({ id: a }) },
    clientAssistanceCase: {
      findFirst: vi.fn().mockImplementation(() => ({ ...current })),
      findUniqueOrThrow: vi.fn().mockImplementation(() => ({ ...current })),
      updateMany: vi.fn().mockImplementation(({ data }) => {
        Object.assign(current, data);
        return { count: 1 };
      }),
    },
    documentVersion: {
      findFirst: vi.fn().mockResolvedValue({ id: b, sha256: Buffer.alloc(32, 1) }),
    },
    clientAssistanceRevision: { create: vi.fn() },
  };
  mocks.tx = db;
  return { db, current };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({
    ok: true,
    staffId: b,
    session: {},
    ctx: { tenantId: a, actorId: b, actorType: 'STAFF' },
  });
});
describe('CLIENT-ASSISTANCE-001 external Word revisions', () => {
  const input = {
    id: a,
    clientId: a,
    kind: 'PROCEDURE',
    expectedRevision: 2,
    documentVersionId: b,
    confirmed: true,
  };
  it('creates a real new submitted revision without rewriting structured answers or inheriting review', async () => {
    const { db } = fixture();
    await reimportAssistance('staff', input);
    expect(db.clientAssistanceCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revision: 3,
          status: 'SUBMITTED',
          externalDocumentVersionId: b,
          reviewedByStaff: null,
          reviewNote: null,
        }),
      }),
    );
    expect(db.clientAssistanceCase.updateMany.mock.calls[0]![0].data).not.toHaveProperty('answers');
    expect(db.clientAssistanceRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        revision: 3,
        externalVersionId: b,
        snapshot: expect.objectContaining({
          reviewNote: null,
          externalVersionId: b,
          answers: { organization: 'Alte Strukturantwort' },
        }),
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
  });
  it('rejects stale reimports before appending a revision', async () => {
    const { db } = fixture();
    db.clientAssistanceCase.findFirst.mockResolvedValue(null as never);
    await expect(reimportAssistance('staff', input)).rejects.toThrow('geändert');
    expect(db.clientAssistanceRevision.create).not.toHaveBeenCalled();
  });
  it('rejects an unavailable or cross-client Word version', async () => {
    const { db } = fixture();
    db.documentVersion.findFirst.mockResolvedValue(null);
    await expect(reimportAssistance('staff', input)).rejects.toThrow('Word-Datei');
    expect(db.clientAssistanceCase.updateMany).not.toHaveBeenCalled();
    expect(db.documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          document: expect.objectContaining({ tenantId: a, clientId: a, deletedAt: null }),
        }),
      }),
    );
  });
  it('requires current portal sharing and prohibits structural editing of an imported Word revision', async () => {
    const { db, current } = fixture();
    mocks.guard.mockResolvedValue({
      ok: true,
      clientId: a,
      ctx: { tenantId: a, actorId: b, actorType: 'CLIENT_CONTACT' },
    });
    await reimportAssistance('portal', input);
    expect(db.documentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          document: expect.objectContaining({ sharedWithClientAt: { not: null } }),
        }),
      }),
    );
    current.status = 'RETURNED';
    await expect(
      saveAssistance('portal', {
        id: a,
        clientId: a,
        kind: 'PROCEDURE',
        expectedRevision: 3,
        submit: false,
        confirmed: false,
        answers: { organization: 'Changed' },
      }),
    ).rejects.toThrow('externe Word-Fassung');
  });
  it('does not silently repeat a completed review decision', async () => {
    fixture();
    await expect(
      reviewAssistance({
        id: a,
        clientId: a,
        kind: 'PROCEDURE',
        expectedRevision: 2,
        decision: 'REVIEWED',
        note: 'Again',
      }),
    ).rejects.toThrow('bereits geprüft');
  });
});
