// Fachkatalog: POA-SIGNING-CONFIRMATION-001, POA-LIFECYCLE-001.
// Exercise real public actions against independently interleaved persisted state.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  owner: {
    powerOfAttorney: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    documentVersion: { findFirst: vi.fn() },
  },
  sendMail: vi.fn(),
  record: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomInt: () => 654321,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_context: unknown, fn: (tx: unknown) => unknown) => fn(m.owner),
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: m.owner }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: m.sendMail }));
vi.mock('@/server/notifications/service', () => ({ notify: m.notify }));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: async () => ({ ok: true }),
  checkIpOrGlobalLimit: async () => ({ ok: true }),
  getClientIp: () => '198.51.100.70',
}));
vi.mock('@/server/actions/staff-action', () => ({}));
vi.mock('@/server/documents/resumable-upload', () => ({}));
import { requestSigningOtpAction, signPoaAction } from '../sign-actions';

const TOKEN = 'synthetic-poa-signing-token-security3';
const OTP = '123456';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
let row: Record<string, unknown>;
let afterRead: null | (() => Promise<void>);

function numeric(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  throw new Error('A numeric persistence predicate requires a date or number');
}

function matches(where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = row[field];
    if (expected instanceof Date)
      return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === 'object') {
      return Object.entries(expected).every(([operator, bound]) => {
        if (operator === 'lt') return numeric(actual) < numeric(bound);
        if (operator === 'lte') return numeric(actual) <= numeric(bound);
        if (operator === 'gt') return numeric(actual) > numeric(bound);
        if (operator === 'gte') return numeric(actual) >= numeric(bound);
        throw new Error(`Unsupported persistence predicate ${operator}`);
      });
    }
    return actual === expected;
  });
}

function apply(data: Record<string, unknown>) {
  for (const [field, value] of Object.entries(data)) {
    row[field] =
      value && typeof value === 'object' && 'increment' in value
        ? numeric(row[field]) + numeric(value.increment)
        : value;
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  afterRead = null;
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    subject: 'Synthetische Vollmacht',
    signerName: 'Testperson',
    signerEmail: 'poa-security3@example.test',
    validFrom: '2026-01-01',
    validUntil: '2099-12-31',
    scope: 'Synthetischer Test',
    document: null,
  });
  row = {
    id: 'poa-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    signerContactId: null,
    status: 'SENT',
    createdByStaff: 'staff-1',
    validUntil: new Date('2099-12-31'),
    signingTokenHash: hash(TOKEN),
    signingTokenExpiresAt: new Date(Date.now() + 3600000),
    signingOtpHash: hash(OTP),
    signingOtpExpiresAt: new Date(Date.now() + 600000),
    signingOtpAttempts: 0,
    signingOtpAttemptsTotal: 0,
    signingContentSnapshot: snapshot,
    signingContentSha256: createHash('sha256').update(snapshot).digest(),
    signingDocumentVersionId: null,
  };
  m.owner.powerOfAttorney.findFirst.mockImplementation(async ({ where }) => {
    const loaded = matches(where) ? { ...row } : null;
    const callback = afterRead;
    afterRead = null;
    if (callback) await callback();
    return loaded;
  });
  m.owner.powerOfAttorney.update.mockImplementation(async ({ where, data }) => {
    if (!matches(where)) throw Object.assign(new Error('No matching record'), { code: 'P2025' });
    apply(data);
    return { ...row };
  });
  m.owner.powerOfAttorney.updateMany.mockImplementation(async ({ where, data }) => {
    if (!matches(where)) return { count: 0 };
    apply(data);
    return { count: 1 };
  });
  m.sendMail.mockResolvedValue({ ok: true });
});

afterEach(() => vi.useRealTimers());

describe('POA-SIGNING-CONFIRMATION-001: overlapping OTP and token lifecycles', () => {
  it('rejects an old code when a real OTP reissue finishes after its lookup but before the signing claim', async () => {
    // The first lookup locates the tenant; pause the transaction's second lookup.
    afterRead = async () => {
      afterRead = async () => {
        expect(await requestSigningOtpAction({ rawToken: TOKEN, consentAccepted: true })).toEqual({
          ok: true,
        });
      };
    };
    const result = await signPoaAction({ rawToken: TOKEN, otp: OTP, consentAccepted: true });
    expect(m.sendMail).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(row.status).toBe('SENT');
    expect(row.signingOtpHash).not.toBe(hash(OTP));
    expect(m.record).not.toHaveBeenCalled();
  });

  it('does not let a pending old-token OTP request overwrite a freshly resent link', async () => {
    afterRead = async () => {
      // Staff's concurrent resend commits a new token and clears the old OTP.
      row.signingTokenHash = hash('replacement-link-token');
      row.signingOtpHash = null;
      row.signingOtpExpiresAt = null;
    };
    const result = await requestSigningOtpAction({ rawToken: TOKEN, consentAccepted: true });
    expect(result.ok).toBe(false);
    expect(row.signingTokenHash).toBe(hash('replacement-link-token'));
    expect(row.signingOtpHash).toBeNull();
    expect(m.sendMail).not.toHaveBeenCalled();
  });

  it('does not debit an old token failed attempt against the replacement link', async () => {
    afterRead = async () => {
      afterRead = async () => {
        row.signingTokenHash = hash('replacement-link-token');
        row.signingOtpHash = null;
        row.signingOtpExpiresAt = null;
      };
    };
    expect(
      (await signPoaAction({ rawToken: TOKEN, otp: '999999', consentAccepted: true })).ok,
    ).toBe(false);
    expect(row.signingOtpAttempts).toBe(0);
    expect(row.signingOtpAttemptsTotal).toBe(0);
    expect(row.signingTokenHash).toBe(hash('replacement-link-token'));
  });

  it('rejects an OTP that expires between validation and the final write', async () => {
    vi.useFakeTimers();
    row.signingOtpExpiresAt = new Date(Date.now() + 1000);
    const documentSha256 = Buffer.alloc(32, 7);
    const documentId = '713f53a9-0622-4c2e-9ef0-1a1151d9bed2';
    const versionId = 'd61ec9a7-d3f1-422d-8913-3327b70826cb';
    const snapshot = JSON.parse(String(row.signingContentSnapshot));
    snapshot.scope = null;
    snapshot.document = { documentId, versionId, sha256: documentSha256.toString('hex') };
    row.signingContentSnapshot = JSON.stringify(snapshot);
    row.signingContentSha256 = createHash('sha256')
      .update(String(row.signingContentSnapshot))
      .digest();
    row.signingDocumentVersionId = versionId;
    m.owner.documentVersion.findFirst.mockImplementation(async () => {
      // This asynchronous integrity read occurs after the initial OTP-expiry check.
      vi.setSystemTime(Date.now() + 1001);
      return { id: versionId, documentId, sha256: documentSha256 };
    });
    const result = await signPoaAction({ rawToken: TOKEN, otp: OTP, consentAccepted: true });
    expect(m.owner.documentVersion.findFirst).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
    expect(row.status).toBe('SENT');
    expect(m.record).not.toHaveBeenCalled();
  });

  it('allows the genuinely current reissued code exactly once', async () => {
    expect(await requestSigningOtpAction({ rawToken: TOKEN, consentAccepted: true })).toEqual({
      ok: true,
    });
    const issued = m.sendMail.mock.calls[0]![0].vars.otp as string;
    expect(await signPoaAction({ rawToken: TOKEN, otp: issued, consentAccepted: true })).toEqual({
      ok: true,
    });
    expect(row.status).toBe('SIGNED');
    expect(m.record).toHaveBeenCalledOnce();
    expect((await signPoaAction({ rawToken: TOKEN, otp: issued, consentAccepted: true })).ok).toBe(
      false,
    );
    expect(m.record).toHaveBeenCalledOnce();
  });
});
