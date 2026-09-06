// Fachkatalog: INV-TIME-ENTRY-CLAIM-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tx: null as unknown, guard: vi.fn(), modules: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(h.tx),
  ),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: vi.fn(),
  toActionError: (error: Error) => ({ ok: false, error: error.message }),
}));
vi.mock('@/server/invoicing/number', () => ({
  allocateInvoiceNumber: vi.fn(async () => '2026-0001'),
}));
vi.mock('@/server/settings/modules', () => ({ readModules: h.modules }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: h.guard,
  ActionError: class extends Error {},
}));

import { createInvoiceFromTimeEntriesAction } from '../actions';
import { generateXRechnungCii } from '@/server/invoicing/xrechnung';
import { SAMPLE_INVOICE, SAMPLE_SELLER, SAMPLE_BUYER } from '@/server/invoicing/sample-fixture';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

describe('Stundenabrechnung — Berlin-Leistungszeitraum bis zur CII-Ausgabe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.guard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant',
      staffId: 'staff',
      ctx: {},
      session: {},
    });
    h.modules.mockResolvedValue({ invoiceMode: 'IN_APP' });
  });

  it.each([
    [
      'Sommernacht',
      '2026-09-06T00:30:00+02:00',
      '2026-09-06T01:30:00+02:00',
      '2026-09-06',
      '2026-09-06',
    ],
    [
      'Winternacht',
      '2026-01-08T00:15:00+01:00',
      '2026-01-08T00:45:00+01:00',
      '2026-01-08',
      '2026-01-08',
    ],
    [
      'Sommerzeitbeginn',
      '2026-03-29T01:30:00+01:00',
      '2026-03-29T03:30:00+02:00',
      '2026-03-29',
      '2026-03-29',
    ],
    [
      'Sommerzeitende',
      '2026-10-25T02:30:00+02:00',
      '2026-10-25T02:30:00+01:00',
      '2026-10-25',
      '2026-10-25',
    ],
    [
      'Jahreswechsel',
      '2025-12-31T23:30:00+01:00',
      '2026-01-01T00:30:00+01:00',
      '2025-12-31',
      '2026-01-01',
    ],
  ])(
    '%s: speichert die fachlichen Kalendertage',
    async (_name, from, to, expectedStart, expectedEnd) => {
      const create = vi.fn(
        async (_args: {
          data: { servicePeriodStart: Date; servicePeriodEnd: Date; netAmount: number };
        }) => ({ id: 'invoice' }),
      );
      const startedAt = new Date(from),
        endedAt = new Date(to);
      h.tx = {
        timeEntry: {
          findMany: vi.fn(async () => [
            {
              id: 'entry',
              startedAt,
              endedAt,
              hourlyRate: null,
              description: 'Telefonberatung',
            },
          ]),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        invoice: { create },
      };

      const result = await createInvoiceFromTimeEntriesAction({
        clientId: CLIENT_ID,
        subject: 'Beratung',
        issueDate: '2026-10-26',
        dueDate: '2026-11-09',
        vatRate: 19,
        reverseCharge: false,
        format: 'XRECHNUNG',
        hourlyRate: 120,
        strategy: 'per-entry',
      });
      expect(result).toEqual({ ok: true, invoiceId: 'invoice' });
      const data = create.mock.calls[0]![0].data;
      expect(data.servicePeriodStart.toISOString()).toBe(`${expectedStart}T00:00:00.000Z`);
      expect(data.servicePeriodEnd.toISOString()).toBe(`${expectedEnd}T00:00:00.000Z`);
      // Nur die Datumsfelder normalisieren: tatsächlich verstrichene Zeit bleibt abrechenbar.
      expect(data.netAmount).toBe(((endedAt.getTime() - startedAt.getTime()) / 3_600_000) * 120);

      const xml = generateXRechnungCii(
        {
          ...SAMPLE_INVOICE,
          servicePeriodStart: data.servicePeriodStart,
          servicePeriodEnd: data.servicePeriodEnd,
        },
        SAMPLE_SELLER,
        SAMPLE_BUYER,
      );
      const period = xml.match(
        /<ram:BillingSpecifiedPeriod>[\s\S]*?<\/ram:BillingSpecifiedPeriod>/,
      )?.[0];
      expect(period).toContain(`>${expectedStart.replaceAll('-', '')}</udt:DateTimeString>`);
      expect(period).toContain(`>${expectedEnd.replaceAll('-', '')}</udt:DateTimeString>`);
    },
  );
});
