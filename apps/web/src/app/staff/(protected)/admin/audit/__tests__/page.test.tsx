import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';

const mocks = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  withTenantContext: vi.fn(),
  signAuditToken: vi.fn(() => 'test-read-only-token'),
  findMany: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
  queryRaw: vi.fn(),
  readSetting: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@taxtronik/db/tenant-settings', () => ({ readTenantSettingValue: mocks.readSetting }));
vi.mock('@taxtronik/config', () => ({ env: { NEXTAUTH_URL: 'https://audit.example.test' } }));
vi.mock('@/server/audit-access/token', () => ({
  signAuditToken: mocks.signAuditToken,
  AUDIT_TOKEN_TTL_DAYS: 7,
}));
vi.mock('@/components/copy-field', () => ({
  CopyField: ({ value }: { value: string }) => (
    <input aria-label="Prüfer-Link" value={value} readOnly />
  ),
}));
vi.mock('../actions', () => ({
  createAuditRecoveryCheckpointAction: '/test/recovery',
  triggerAuditVerifyAction: '/test/verify',
}));
vi.mock('../audit-anchor-auto-refresh', () => ({ AuditAnchorAutoRefresh: () => null }));
vi.mock('../audit-verify-auto-refresh', () => ({
  AuditVerifyAutoRefresh: ({ requestId }: { requestId: string }) => <span data-poll={requestId} />,
}));
vi.mock('../audit-notification-acknowledger', () => ({
  AuditNotificationAcknowledger: ({ resultKey }: { resultKey: string | null }) =>
    resultKey ? <span data-acknowledge={resultKey} /> : null,
}));

import AuditLogPage from '../page';

const tenantId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const hash = Buffer.from('0123456789abcdef'.repeat(4), 'hex');

function entry(id: bigint) {
  return {
    id,
    tenantId,
    occurredAt: new Date('2026-09-07T09:10:11Z'),
    actorType: 'STAFF',
    actorId: staffId,
    action: 'document.upload',
    resourceType: 'document',
    resourceId: 'document-1',
    before: null,
    after: null,
    ip: null,
    userAgent: null,
    prevHash: hash,
    thisHash: hash,
  };
}

async function renderPage(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await AuditLogPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffAuth.mockResolvedValue({ user: { tenantId, staffId, roles: ['ADMIN'] } });
  mocks.findMany.mockImplementation(async ({ where }) =>
    where.id === 0n ? [] : [entry(2n), entry(1n)],
  );
  mocks.count.mockImplementation(async ({ where }) => (where.id === 0n ? 0 : 2));
  mocks.groupBy.mockResolvedValue([{ resourceType: 'document' }]);
  mocks.readSetting.mockResolvedValue(null);
  // The table contains many tenants. pg_class statistics are global even in an RLS transaction.
  mocks.queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
    sql.join('').includes('pg_class') ? [{ estimate: 1317n }] : [],
  );
  mocks.withTenantContext.mockImplementation(async (_context, run) =>
    run({
      auditLog: { findMany: mocks.findMany, count: mocks.count, groupBy: mocks.groupBy },
      $queryRaw: mocks.queryRaw,
    }),
  );
});

describe('AUDIT-HASH-CHAIN-001 / ACCESS-TENANT-RLS-001: audit page isolation', () => {
  it('shows the current tenant count instead of the database-wide table estimate', async () => {
    const html = await renderPage();

    expect(html).toContain('2 Einträge gesamt · zeige 2');
    expect(html).not.toContain('~1.300');
    expect(mocks.withTenantContext).toHaveBeenCalledWith(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      expect.any(Function),
    );
    expect(mocks.count).toHaveBeenCalledOnce();
    expect(mocks.count).toHaveBeenCalledWith({ where: { tenantId } });
  });

  it.each([null, { user: { tenantId, staffId, roles: ['EMPLOYEE'] } }])(
    'rejects an unauthorized page before database reads or issuing an auditor token (%j)',
    async (session) => {
      mocks.staffAuth.mockResolvedValue(session);
      await expect(renderPage()).rejects.toThrow('redirect:');
      expect(mocks.withTenantContext).not.toHaveBeenCalled();
      expect(mocks.signAuditToken).not.toHaveBeenCalled();
    },
  );

  it('continues to allow PARTNER access', async () => {
    mocks.staffAuth.mockResolvedValue({ user: { tenantId, staffId, roles: ['PARTNER'] } });
    expect(await renderPage()).toContain('2 Einträge gesamt');
  });

  it('rejects invalid filters without listing all events or exposing an export link', async () => {
    const html = await renderPage({ from: '2026-09-08', to: '2026-09-07' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Von darf nicht nach Bis liegen.');
    expect(html).toContain('0 Treffer · zeige 0');
    expect(html).toContain('Keine Einträge.');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('href="/api/staff/admin/audit/export');
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId, id: 0n } }),
    );
    expect(mocks.count).toHaveBeenCalledWith({ where: { tenantId, id: 0n } });
  });

  it.each(['newest', 'oldest'])(
    'keeps %s pagination exclusive, bounded and separate from count/export',
    async (sort) => {
      const firstId = 9007199254741100n;
      const ids = Array.from(
        { length: 51 },
        (_, i) => firstId + BigInt(sort === 'oldest' ? i : -i),
      );
      mocks.findMany.mockResolvedValue(ids.map(entry));
      mocks.count.mockResolvedValue(120);
      const cursor = '9007199254740993';
      const html = await renderPage({
        action: 'document',
        category: 'documents',
        actorType: 'STAFF',
        resourceType: 'document',
        from: '2026-03-29',
        to: '2026-03-29',
        sort,
        cursor,
      });
      const call = mocks.findMany.mock.calls[0]![0];
      expect(call).toMatchObject({
        where: {
          tenantId,
          action: { contains: 'document' },
          actorType: 'STAFF',
          resourceType: 'document',
          AND: [{ action: { in: expect.arrayContaining(['document.upload']) } }],
          occurredAt: {
            gte: new Date('2026-03-28T23:00:00Z'),
            lt: new Date('2026-03-29T22:00:00Z'),
          },
          id: sort === 'oldest' ? { gt: BigInt(cursor) } : { lt: BigInt(cursor) },
        },
        orderBy: { id: sort === 'oldest' ? 'asc' : 'desc' },
        take: 51,
      });
      const { id: _cursorCondition, ...countWhere } = call.where;
      expect(mocks.count).toHaveBeenCalledWith({ where: countWhere });
      expect(html).toContain('120 Treffer · zeige 50');
      expect(html).toContain(`/staff/admin/audit/${ids[49]}`);
      expect(html).not.toContain(`/staff/admin/audit/${ids[50]}`);
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) =>
        m[1]!.replaceAll('&amp;', '&'),
      );
      const exported = new URL(
        hrefs.find((href) => href.startsWith('/api/staff/admin/audit/export'))!,
        'https://audit.example.test',
      );
      const next = new URL(
        hrefs.find((href) => href.includes('cursor='))!,
        'https://audit.example.test',
      );
      expect(exported.searchParams.has('cursor')).toBe(false);
      expect(next.searchParams.get('cursor')).toBe(String(ids[49]));
      for (const [key, value] of exported.searchParams)
        expect(next.searchParams.get(key)).toBe(value);
      expect(html).toContain(sort === 'oldest' ? 'Neuere Einträge' : 'Ältere Einträge');
    },
  );

  it('does not promise another page when exactly 50 events remain', async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => entry(BigInt(50 - i))));
    const html = await renderPage({ cursor: '51' });
    expect(html).toContain('Ende der Liste');
    expect(html).toContain('Zur ersten Seite');
    expect(html).not.toContain('cursor=');
  });
});

const checkedAt = '2026-09-07T10:00:00Z';
function verification(overrides: Partial<PersistedVerifyResult> = {}) {
  return {
    ok: true,
    checkedAt,
    checked: 120,
    sealsChecked: 2,
    sealBreaks: 0,
    anchorsChecked: 4,
    requestId: 'finished-run',
    tsaMode: 'rfc3161',
    sealsTrustAnchored: 2,
    ...overrides,
  };
}

function persistVerification(result: ReturnType<typeof verification> | null, checkpoint = false) {
  mocks.readSetting.mockImplementation(async (_tx, id, key) => {
    expect(id).toBe(tenantId);
    if (key === AUDIT_VERIFY_RESULT_SETTING_KEY) return result;
    if (key === AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY && checkpoint) return { auditId: '50' };
    return null;
  });
}

describe('AUDIT-VERIFY-ALERT-001: rendered persisted status', () => {
  it('keeps a filtered excerpt separate from the complete chain result and acknowledges success', async () => {
    persistVerification(verification());
    const html = await renderPage({ category: 'documents' });
    expect(html).toContain('Hash-Chain intakt — 120 Einträge geprüft');
    expect(html).toContain('4 Rolling-Anker geprüft');
    expect(html).toContain('data-acknowledge="2026-09-07T10:00:00Z:finished-run"');
    expect(html).toContain('Prüfstatus gilt für die vollständige Kanzlei-Kette');
    expect(html).not.toContain('Recovery-Checkpoint anlegen');
  });

  it.each([
    { result: null, text: 'Noch kein Prüfergebnis', recovery: false },
    {
      result: verification({ ok: false, recovered: true }),
      text: 'Historischer Chain-Befund',
      recovery: false,
    },
    {
      result: verification({ ok: false, recovered: false, policyBreaks: ['Tail-Truncation'] }),
      text: 'Tail-Truncation',
      recovery: true,
    },
    {
      result: verification({ ok: false, recovered: true, error: 'database unavailable' }),
      text: 'Fehler: database unavailable',
      recovery: true,
    },
  ])(
    'renders $text with an old checkpoint without hiding fresh failures',
    async ({ result, text, recovery }) => {
      persistVerification(result, true);
      const html = await renderPage();
      expect(html).toContain(text);
      expect(html.includes('Recovery-Checkpoint anlegen')).toBe(recovery);
      expect(html).not.toContain('data-acknowledge=');
      if (recovery) expect(html).not.toContain('Historischer Chain-Befund');
    },
  );

  it('continues showing seal, rolling anchor and policy evidence on a broken chain', async () => {
    persistVerification(
      verification({
        ok: false,
        sealBreaks: 2,
        anchorBreaks: 3,
        firstBreak: { auditId: '17', occurredAt: checkedAt },
        policyBreaks: ['TSA required'],
      }),
    );
    const html = await renderPage();
    for (const text of [
      'Erster Bruch bei Audit-ID 17',
      '2 Tagesversiegelung(en) mit TSA-Problem',
      '3 externe Rolling-Verankerung(en) mit Integritätsproblem',
      'TSA required',
    ])
      expect(html).toContain(text);
  });

  it.each([
    { result: null, queuedAt: '2026-09-07T09:59:00Z', requestId: 'pending-run', polls: true },
    {
      result: verification(),
      queuedAt: '2026-09-07T10:01:00Z',
      requestId: 'finished-run',
      polls: false,
    },
    {
      result: verification(),
      queuedAt: '2026-09-07T09:59:00Z',
      requestId: 'overwritten-run',
      polls: false,
    },
    { result: verification(), queuedAt: checkedAt, requestId: 'pending-run', polls: true },
    { result: verification(), queuedAt: 'invalid', requestId: 'pending-run', polls: true },
    { result: verification(), queuedAt: '2026-09-07T10:01:00Z', requestId: '', polls: false },
  ])(
    'polls=$polls for queued request $requestId at $queuedAt',
    async ({ result, queuedAt, requestId, polls }) => {
      persistVerification(result);
      const html = await renderPage({ verify: 'queued', queuedAt, requestId });
      expect(html.includes('Prüfung angestoßen')).toBe(polls);
      expect(html.includes('data-poll=')).toBe(polls);
    },
  );
});
