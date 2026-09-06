import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';

const m = vi.hoisted(() => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({ canStaffWriteClientTx: vi.fn() }));

import { buildClientTimeline } from '../build';

const CTX: TenantContext = { tenantId: 'tenant', actorId: 'staff', actorType: 'STAFF' };
const CLIENT = 'client';
const JANUARY = new Date('2026-01-01T12:00:00Z');
const MAY = new Date('2026-05-01T12:00:00Z');
const JUNE = new Date('2026-06-01T12:00:00Z');
const JULY = new Date('2026-07-01T12:00:00Z');

const MODELS = [
  'document',
  'request',
  'requestResponse',
  'phoneNote',
  'invoice',
  'gwgCheck',
  'powerOfAttorney',
  'taxNotice',
  'taxDeadline',
  'workflowItem',
  'riskAnalysis',
] as const;
type Model = (typeof MODELS)[number];
type Row = { id: string; [key: string]: unknown };
type Query = {
  where: Record<string, unknown>;
  orderBy: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>;
  take: number;
};

/** Evaluate the persistence boundary, including filtering and LIMIT before projection. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, filter]) => {
    const value = row[field];
    if (filter && typeof filter === 'object') {
      const condition = filter as Record<string, unknown>;
      if ('lt' in condition || 'not' in condition) {
        if ('not' in condition && value === condition.not) return false;
        return !('lt' in condition) || (value instanceof Date && value < (condition.lt as Date));
      }
      return Boolean(value && typeof value === 'object' && matches(value as Row, condition));
    }
    return value === filter;
  });
}

function database(rows: Partial<Record<Model, Row[]>>) {
  const tx = Object.fromEntries(
    MODELS.map((model) => [
      model,
      {
        findMany: vi.fn(async ({ where, orderBy, take }: Query) => {
          const ordering = Array.isArray(orderBy) ? orderBy : [orderBy];
          return (rows[model] ?? [])
            .filter((row) => matches(row, where))
            .sort((a, b) => {
              for (const clause of ordering) {
                const [field, direction] = Object.entries(clause)[0]!;
                const left = a[field] instanceof Date ? a[field].getTime() : String(a[field]);
                const right = b[field] instanceof Date ? b[field].getTime() : String(b[field]);
                const comparison = left < right ? -1 : left > right ? 1 : 0;
                if (comparison) return direction === 'asc' ? comparison : -comparison;
              }
              return 0;
            })
            .slice(0, take);
        }),
      },
    ]),
  );
  m.withTenantContext.mockImplementation(
    (_ctx: TenantContext, callback: (tx: unknown) => unknown) => callback(tx),
  );
  return tx;
}

const CASES: Array<{
  rule: string;
  model: Model;
  field: string;
  event: string;
  values: Record<string, unknown>;
}> = [
  {
    rule: 'REQ-LIFECYCLE-001',
    model: 'request',
    field: 'closedAt',
    event: 'req-close',
    values: { title: 'Unterlagen', priority: 'NORMAL', closedAt: null },
  },
  {
    rule: 'INV-LIFECYCLE-FREEZE-001',
    model: 'invoice',
    field: 'sentAt',
    event: 'inv-sent',
    values: { number: 'R-1', subject: 'Beratung', totalAmount: '100', sentAt: null, paidAt: null },
  },
  {
    rule: 'INV-LIFECYCLE-FREEZE-001',
    model: 'invoice',
    field: 'paidAt',
    event: 'inv-paid',
    values: { number: 'R-1', subject: 'Beratung', totalAmount: '100', sentAt: null, paidAt: null },
  },
  {
    rule: 'GWG-RISK-REVIEW-001',
    model: 'gwgCheck',
    field: 'verifiedAt',
    event: 'gwg-verify',
    values: { status: 'VERIFIED', riskLevel: 'LOW', verifiedAt: null, rejectedReason: null },
  },
  {
    rule: 'POA-LIFECYCLE-001',
    model: 'powerOfAttorney',
    field: 'signedAt',
    event: 'poa-sign',
    values: {
      subject: 'Vollmacht',
      signerName: 'Test',
      signedAt: null,
      revokedAt: null,
      revokedReason: null,
    },
  },
  {
    rule: 'POA-LIFECYCLE-001',
    model: 'powerOfAttorney',
    field: 'revokedAt',
    event: 'poa-revoke',
    values: {
      subject: 'Vollmacht',
      signerName: 'Test',
      signedAt: null,
      revokedAt: null,
      revokedReason: null,
    },
  },
  {
    rule: 'RISK-ARCHIVE-SNAPSHOT-001',
    model: 'riskAnalysis',
    field: 'archivedAt',
    event: 'ra-arch',
    values: {
      title: 'Analyse',
      textHash: 'hash',
      katalogVersion: 'v1',
      vertraulich: false,
      archivedAt: null,
      _count: { markings: 0 },
    },
  },
];

beforeEach(() => vi.clearAllMocks());

describe('Timeline: Reihenfolge nach Ereigniszeit statt Anlagedatum', () => {
  it.each(CASES)(
    '$rule: $field eines alten Vorgangs bleibt vor neueren Anlagen sichtbar',
    async ({ model, field, event, values }) => {
      database({
        [model]: [
          { ...values, id: 'older', clientId: CLIENT, createdAt: JANUARY, [field]: JULY },
          { ...values, id: 'newer', clientId: CLIENT, createdAt: JUNE },
          { ...values, id: 'other-client', clientId: 'other', createdAt: JULY, [field]: JULY },
        ],
      });
      const events = await buildClientTimeline(CTX, { clientId: CLIENT, limit: 1 });
      expect(events.map((event) => event.id)).toEqual([`${event}:older`]);
    },
  );

  it.each(CASES)(
    '$rule: $field am oder nach before wird nicht erneut ausgegeben',
    async ({ model, field, values }) => {
      database({
        [model]: [
          { ...values, id: 'at-boundary', clientId: CLIENT, createdAt: JANUARY, [field]: JUNE },
          { ...values, id: 'after-boundary', clientId: CLIENT, createdAt: JANUARY, [field]: JULY },
        ],
      });
      const events = await buildClientTimeline(CTX, { clientId: CLIENT, before: JUNE });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.occurredAt < JUNE)).toBe(true);
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    },
  );

  it('INV-LIFECYCLE-FREEZE-001: findet ältere Zahlungen auch auf einer zeitlich begrenzten Seite', async () => {
    const values = CASES.find((test) => test.event === 'inv-paid')!.values;
    database({
      invoice: [
        { ...values, id: 'paid', clientId: CLIENT, createdAt: JANUARY, paidAt: MAY },
        { ...values, id: 'draft', clientId: CLIENT, createdAt: new Date('2026-04-01T12:00:00Z') },
      ],
    });
    expect(
      (await buildClientTimeline(CTX, { clientId: CLIENT, before: JUNE, limit: 1 })).map(
        (event) => event.id,
      ),
    ).toEqual(['inv-paid:paid']);
  });

  it('löst gleiche Zeitpunkte stabil auf, bevor die Datenbank das Limit anwendet', async () => {
    database({
      document: ['b', 'a'].map((id) => ({
        id,
        clientId: CLIENT,
        createdAt: JANUARY,
        title: id,
        classification: 'OTHER',
      })),
    });
    expect(
      (await buildClientTimeline(CTX, { clientId: CLIENT, limit: 1 })).map((event) => event.id),
    ).toEqual(['doc:a']);
  });

  it('REQ-LIFECYCLE-001: gleiche Zeitpunkte verschiedener Ereignisse sind stabil und ohne Duplikate', async () => {
    database({
      request: [
        {
          id: 'request',
          clientId: CLIENT,
          createdAt: JANUARY,
          closedAt: JANUARY,
          title: 'Unterlagen',
          priority: 'NORMAL',
        },
      ],
    });
    expect((await buildClientTimeline(CTX, { clientId: CLIENT })).map((event) => event.id)).toEqual(
      ['req-close:request', 'req-open:request'],
    );
  });
});
