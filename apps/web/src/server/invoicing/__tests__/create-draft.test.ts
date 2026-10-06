// Fachkatalog: INV-NUMBER-ALLOCATION-001, INV-VAT-TOTALS-001, INV-TIME-ENTRY-CLAIM-001
// Fachkatalog: STBVV-CALCULATION-001, INV-ARCHIVE-EINVOICE-001
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@taxtronik/db/prisma-client';
import { STBVV_VERSION } from '@taxtronik/tax';

const h = vi.hoisted(() => ({
  events: [] as Array<[string, unknown]>,
  tx: null as unknown,
  seller: { vatId: 'DE123456789' as string | null },
  record: vi.fn(),
  allocate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ commitDocumentFromBytes: vi.fn() }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: () => 'https://portal.test' }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/documents/upload-helpers', () => ({ createDocumentWithVersion: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({ compensateStorageCommit: vi.fn() }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: vi.fn() }));
vi.mock('@/server/invoicing/archive', () => ({ ensureZugferdArchive: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({
  readModules: vi.fn(async () => ({ invoiceMode: 'IN_APP' })),
}));
vi.mock('@/server/settings/tenant-settings', () => ({
  readSellerInfoTx: vi.fn(async () => h.seller),
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: vi.fn(async () => {
    h.events.push(['access', null]);
  }),
}));
vi.mock('@/server/invoicing/number', async (original) => ({
  ...(await original<typeof import('../number')>()),
  allocateInvoiceNumber: h.allocate,
}));
vi.mock('@/server/actions/staff-action', async () => {
  const staffActionGuard = async () => ({
    ok: true as const,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
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
    withStaff: vi.fn(),
    parseFormData: vi.fn(),
  };
});

import { round2 } from '@/lib/fmt';
import { createInvoiceAction } from '@/app/staff/(protected)/invoices/actions';
import { createInvoiceFromTimeEntriesAction } from '@/app/staff/(protected)/clients/[id]/billing/actions';
import { createFeeInvoice, validateFeeCalculation } from '@/server/stbvv/service';
import {
  checkDraftInvoice,
  createDraftInvoiceTx,
  type DraftInvoiceHeader,
  type DraftInvoicePositionInput,
} from '../create-draft';

const TENANT = 'tenant-1';
const STAFF = 'staff-1';
const CLIENT = '11111111-1111-4111-8111-111111111111';

function makeTx(
  opts: {
    entries?: unknown[];
    quote?: unknown;
    claimed?: number;
    clientVatId?: string | null;
  } = {},
) {
  const entries = opts.entries ?? [];
  return {
    $executeRaw: vi.fn(async () => 1),
    client: {
      findUnique: vi.fn(async () => {
        h.events.push(['clientVatId', null]);
        return { vatId: opts.clientVatId === undefined ? 'ATU12345678' : opts.clientVatId };
      }),
      findFirst: vi.fn(async () => ({ id: CLIENT })),
    },
    timeEntry: {
      findMany: vi.fn(async () => entries),
      updateMany: vi.fn(async (args: unknown) => {
        h.events.push(['claim', args]);
        return { count: opts.claimed ?? entries.length };
      }),
    },
    invoice: {
      create: vi.fn(async (args: unknown) => {
        h.events.push(['create', args]);
        return { id: 'invoice-1' };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    stbvvQuote: { findFirst: vi.fn(async () => opts.quote ?? null) },
    stbvvQuoteExport: {
      create: vi.fn(async (args: unknown) => {
        h.events.push(['export', args]);
        return {};
      }),
    },
  };
}

function kinds(): string[] {
  return h.events.map(([kind]) => kind);
}
function eventOf(kind: string): unknown {
  return h.events.find(([k]) => k === kind)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T10:00:00.000Z'));
  h.events = [];
  h.seller = { vatId: 'DE123456789' };
  h.allocate.mockImplementation(async (_tx: unknown, tenantId: string, issueDate: Date) => {
    h.events.push(['allocate', { tenantId, issueDate: issueDate.toISOString() }]);
    return '2026-0042';
  });
  h.record.mockImplementation(async (_tx: unknown, event: unknown) => {
    h.events.push(['audit', event]);
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const HEADER: DraftInvoiceHeader = {
  clientId: CLIENT,
  subject: 'Beratung',
  issueDate: new Date('2026-10-05'),
  dueDate: new Date('2026-10-19'),
  servicePeriodStart: null,
  servicePeriodEnd: null,
  vatExemptionReason: null,
  reverseCharge: false,
  format: 'XRECHNUNG',
  notes: null,
};
const POSITION: DraftInvoicePositionInput = {
  description: 'Beratung',
  quantity: 1,
  unitPrice: 100,
  unit: 'Std.',
  vatRate: 19,
};

describe('createDraftInvoiceTx – Prüfungen vor der Nummernvergabe', () => {
  it.each<[string, Partial<DraftInvoiceHeader>, DraftInvoicePositionInput[], RegExp]>([
    ['Rechnungsjahr ± 1', { issueDate: new Date('2029-01-02') }, [POSITION], /laufendes Jahr ± 1/],
    [
      'halber Leistungszeitraum',
      { servicePeriodStart: new Date('2026-09-01') },
      [POSITION],
      /Start UND Ende/,
    ],
    [
      'Leistungszeitraum rückwärts',
      { servicePeriodStart: new Date('2026-09-30'), servicePeriodEnd: new Date('2026-09-01') },
      [POSITION],
      /Start liegt nach dem Ende/,
    ],
    ['keine Position', {}, [], /Mindestens eine Position/],
    ['Fantasiesatz', {}, [{ ...POSITION, vatRate: 13 }], /Ungültiger USt-Satz/],
    ['negativer Preis (BR-27)', {}, [{ ...POSITION, unitPrice: -1 }], /nicht negativ/],
    ['dritte Nachkommastelle', {}, [{ ...POSITION, quantity: 1.234 }], /zwei Nachkommastellen/],
    ['Decimal(10,2)', {}, [{ ...POSITION, unitPrice: 100_000_000 }], /Einzelpreis zu groß/],
    [
      'Positionsbetrag Decimal(12,2)',
      {},
      [{ ...POSITION, quantity: 100_000, unitPrice: 99_999_999.99 }],
      /Positionsbetrag zu groß/,
    ],
    [
      'Kopfsumme Decimal(12,2)',
      {},
      [{ ...POSITION, quantity: 100_000, unitPrice: 99_999.99 }],
      /Rechnungssumme zu groß/,
    ],
    ['Reverse-Charge mit USt', { reverseCharge: true }, [POSITION], /alle Positionen müssen 0 %/],
    ['0 % ohne Grund', {}, [{ ...POSITION, vatRate: 0 }], /Befreiungsgrund/],
  ])('%s', async (_name, header, positions, message) => {
    const tx = makeTx();
    await expect(
      createDraftInvoiceTx(
        tx as never,
        { tenantId: TENANT, staffId: STAFF },
        { ...HEADER, ...header },
        positions,
        { kind: 'manual' },
      ),
    ).rejects.toThrow(message);
    expect(h.allocate).not.toHaveBeenCalled();
    expect(tx.invoice.create).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('§ 13b UStG / BR-AE-01: ohne USt-IdNr der Kanzlei keine Nummer', async () => {
    h.seller = { vatId: null };
    const tx = makeTx();
    await expect(
      createDraftInvoiceTx(
        tx as never,
        { tenantId: TENANT, staffId: STAFF },
        { ...HEADER, reverseCharge: true },
        [{ ...POSITION, vatRate: 0 }],
        { kind: 'manual' },
      ),
    ).rejects.toThrow('Reverse-Charge (§ 13b UStG) erfordert die USt-IdNr der Kanzlei');
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('§ 13b UStG / BT-48: ohne USt-IdNr des Mandanten keine Nummer', async () => {
    const tx = makeTx({ clientVatId: null });
    await expect(
      createDraftInvoiceTx(
        tx as never,
        { tenantId: TENANT, staffId: STAFF },
        { ...HEADER, reverseCharge: true },
        [{ ...POSITION, vatRate: 0 }],
        { kind: 'manual' },
      ),
    ).rejects.toThrow('USt-IdNr des Mandanten');
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('legt Reverse-Charge mit beiden USt-IdNrn an (Kategorie AE, 0 %)', async () => {
    const tx = makeTx();
    const created = await createDraftInvoiceTx(
      tx as never,
      { tenantId: TENANT, staffId: STAFF },
      { ...HEADER, reverseCharge: true },
      [{ ...POSITION, vatRate: 0 }],
      { kind: 'manual' },
    );
    expect(created).toMatchObject({ id: 'invoice-1', number: '2026-0042' });
    expect(kinds()).toEqual(['clientVatId', 'allocate', 'create', 'audit']);
  });
});

describe('createDraftInvoiceTx – einheitliche Fehlerabbildung', () => {
  // F-03: echte Prisma-Fehlerformen (Unique-Konflikt bzw. Trigger mit SQLSTATE).
  it.each([
    [
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
      'Rechnungsnummer existiert bereits.',
    ],
    [
      new Prisma.PrismaClientKnownRequestError('Database error. Code: `23514`.', {
        code: 'P2039',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23514',
              originalMessage:
                'Mandant 1 ist nicht aktiv (GwG-Schranke). Rechnungsanlage abgewiesen.',
              kind: 'postgres',
            },
          },
        },
      }),
      'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).',
    ],
  ])('bildet %s ab', async (dbError, message) => {
    const tx = makeTx();
    tx.invoice.create.mockRejectedValueOnce(dbError);
    await expect(
      createDraftInvoiceTx(tx as never, { tenantId: TENANT, staffId: STAFF }, HEADER, [POSITION], {
        kind: 'stbvv_quote',
        quoteId: 'quote-1',
      }),
    ).rejects.toThrow(message);
    expect(tx.stbvvQuoteExport.create).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('reicht unbekannte Fehler unverändert weiter', async () => {
    const tx = makeTx();
    const failure = new Error('connection reset');
    tx.invoice.create.mockRejectedValueOnce(failure);
    await expect(
      createDraftInvoiceTx(tx as never, { tenantId: TENANT, staffId: STAFF }, HEADER, [POSITION], {
        kind: 'manual',
      }),
    ).rejects.toBe(failure);
  });

  it('INV-TIME-ENTRY-CLAIM-001: verlorener Claim bricht vor dem Audit ab', async () => {
    const tx = makeTx({ claimed: 1 });
    await expect(
      createDraftInvoiceTx(tx as never, { tenantId: TENANT, staffId: STAFF }, HEADER, [POSITION], {
        kind: 'time_entries',
        entryIds: ['e1', 'e2'],
        strategy: 'one-line',
      }),
    ).rejects.toThrow('bereits abgerechnet');
    expect(kinds()).toEqual(['allocate', 'create', 'claim']);
  });
});

describe('Manuelle Rechnung über den Service – unveränderte Anlage', () => {
  it('Nummer, Kopf, Positionen und Audit wie bisher (Mischsätze, Gruppenrundung)', async () => {
    h.tx = makeTx();
    const result = await createInvoiceAction({
      clientId: CLIENT,
      subject: 'Beratung Q3',
      issueDate: '2026-10-05',
      dueDate: '2026-10-19',
      notes: 'Danke',
      servicePeriodStart: '2026-07-01',
      servicePeriodEnd: '2026-09-30',
      vatExemptionReason: '',
      reverseCharge: false,
      format: 'ZUGFERD',
      positions: [
        { description: 'Beratung', quantity: 1.5, unitPrice: 120, unit: 'Std.', vatRate: 19 },
        { description: 'Fachbuch', quantity: 3, unitPrice: 0.33, unit: 'Stück', vatRate: 7 },
        { description: 'Kopien', quantity: 3, unitPrice: 0.33, unit: 'Stück', vatRate: 19 },
      ],
    });

    expect(result).toEqual({ ok: true, invoiceId: 'invoice-1', number: '2026-0042' });
    expect(kinds()).toEqual(['access', 'allocate', 'create', 'audit']);
    expect(eventOf('allocate')).toEqual({
      tenantId: TENANT,
      issueDate: '2026-10-05T00:00:00.000Z',
    });
    expect(eventOf('create')).toEqual({
      data: {
        tenantId: TENANT,
        clientId: CLIENT,
        number: '2026-0042',
        subject: 'Beratung Q3',
        issueDate: new Date('2026-10-05'),
        dueDate: new Date('2026-10-19'),
        servicePeriodStart: new Date('2026-07-01'),
        servicePeriodEnd: new Date('2026-09-30'),
        vatExemptionReason: null,
        reverseCharge: false,
        status: 'DRAFT',
        format: 'ZUGFERD',
        netAmount: 181.98,
        vatAmount: 34.46,
        totalAmount: 216.44,
        vatRate: null,
        notes: 'Danke',
        createdByStaff: STAFF,
        positions: {
          create: [
            {
              position: 1,
              description: 'Beratung',
              quantity: 1.5,
              unitPrice: 120,
              unit: 'Std.',
              netAmount: 180,
              vatRate: 19,
            },
            {
              position: 2,
              description: 'Fachbuch',
              quantity: 3,
              unitPrice: 0.33,
              unit: 'Stück',
              netAmount: 0.99,
              vatRate: 7,
            },
            {
              position: 3,
              description: 'Kopien',
              quantity: 3,
              unitPrice: 0.33,
              unit: 'Stück',
              netAmount: 0.99,
              vatRate: 19,
            },
          ],
        },
      },
    });
    expect(eventOf('audit')).toEqual({
      tenantId: TENANT,
      actorType: 'STAFF',
      actorId: STAFF,
      action: 'invoice.create',
      resourceType: 'invoice',
      resourceId: 'invoice-1',
      after: { number: '2026-0042', clientId: CLIENT, totalAmount: 216.44, format: 'ZUGFERD' },
    });
  });

  it('Reverse-Charge ohne USt-IdNr der Kanzlei: Ablehnung ohne Nummer', async () => {
    h.seller = { vatId: null };
    h.tx = makeTx();
    const result = await createInvoiceAction({
      clientId: CLIENT,
      subject: 'Beratung',
      issueDate: '2026-10-05',
      dueDate: '2026-10-19',
      reverseCharge: true,
      format: 'XRECHNUNG',
      positions: [
        { description: 'Beratung', quantity: 1, unitPrice: 100, unit: 'Std.', vatRate: 0 },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('erfordert die USt-IdNr der Kanzlei'),
    });
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('prüft Rechnungsjahr und Beträge weiterhin vor jeder Transaktion', async () => {
    h.tx = makeTx();
    const result = await createInvoiceAction({
      clientId: CLIENT,
      subject: 'Beratung',
      issueDate: '2020-01-01',
      dueDate: '2020-01-15',
      format: 'XRECHNUNG',
      positions: [{ description: 'B', quantity: 1, unitPrice: 1, unit: 'Std.', vatRate: 19 }],
    });
    expect(result).toEqual({
      ok: false,
      error: 'Rechnungsdatum liegt außerhalb des plausiblen Bereichs (laufendes Jahr ± 1).',
    });
    expect(h.events).toEqual([]);
  });
});

function entry(id: string, from: string, minutes: number, hourlyRate: string | null) {
  const startedAt = new Date(from);
  return {
    id,
    startedAt,
    endedAt: new Date(startedAt.getTime() + minutes * 60_000),
    hourlyRate: hourlyRate === null ? null : { toString: () => hourlyRate },
    description: `Tätigkeit ${id}`,
  };
}

const TIME_INPUT = {
  clientId: CLIENT,
  subject: 'Beratung September',
  issueDate: '2026-10-05',
  dueDate: '2026-10-19',
  vatRate: 19,
  vatExemptionReason: '',
  reverseCharge: false,
  format: 'XRECHNUNG' as const,
  hourlyRate: 120,
  notes: '',
};

describe('Stundenabrechnung über den Service – unveränderte Anlage', () => {
  const ENTRIES = [
    entry('e1', '2026-09-01T09:00:00+02:00', 70, null),
    entry('e2', '2026-09-03T14:00:00+02:00', 25, '96.5'),
    entry('e3', '2026-09-10T08:00:00+02:00', 7, null),
  ];

  it.each(['per-entry', 'one-line'] as const)(
    '%s: Nummer, Kopf, Positionen, Claim und Audit wie bisher',
    async (strategy) => {
      h.tx = makeTx({ entries: ENTRIES });

      const result = await createInvoiceFromTimeEntriesAction({ ...TIME_INPUT, strategy });

      expect(result).toEqual({ ok: true, invoiceId: 'invoice-1' });
      expect(kinds()).toEqual(['access', 'allocate', 'create', 'claim', 'audit']);
      // 70 Min. × 120 = 140,00; 25 Min. × 96,50 = 40,21; 7 Min. × 120 = 14,00.
      const positions =
        strategy === 'per-entry'
          ? [
              [1, '70 Min. × 120.00 €/Std.', 140],
              [2, '25 Min. × 96.50 €/Std.', 40.21],
              [3, '7 Min. × 120.00 €/Std.', 14],
            ].map(([position, text, net]) => ({
              position,
              description: expect.stringContaining(text as string),
              quantity: 1,
              unitPrice: net,
              unit: 'pauschal',
              netAmount: net,
              vatRate: 19,
            }))
          : [
              {
                position: 1,
                description: 'Beratung September (1.7 Std.)',
                quantity: 1,
                unitPrice: 194.21,
                unit: 'pauschal',
                netAmount: 194.21,
                vatRate: 19,
              },
            ];
      expect(eventOf('create')).toEqual({
        data: {
          tenantId: TENANT,
          clientId: CLIENT,
          number: '2026-0042',
          subject: 'Beratung September',
          issueDate: new Date('2026-10-05'),
          dueDate: new Date('2026-10-19'),
          servicePeriodStart: new Date('2026-09-01'),
          servicePeriodEnd: new Date('2026-09-10'),
          vatExemptionReason: null,
          reverseCharge: false,
          status: 'DRAFT',
          format: 'XRECHNUNG',
          netAmount: 194.21,
          vatAmount: 36.9,
          totalAmount: 231.11,
          vatRate: 19,
          notes: null,
          createdByStaff: STAFF,
          positions: { create: positions },
        },
      });
      expect(eventOf('claim')).toEqual({
        where: { id: { in: ['e1', 'e2', 'e3'] }, invoiceId: null },
        data: { invoiceId: 'invoice-1' },
      });
      expect(eventOf('audit')).toEqual({
        tenantId: TENANT,
        actorType: 'STAFF',
        actorId: STAFF,
        action: 'invoice.create.from_time',
        resourceType: 'invoice',
        resourceId: 'invoice-1',
        after: {
          number: '2026-0042',
          clientId: CLIENT,
          timeEntryCount: 3,
          totalAmount: 231.11,
          strategy,
        },
      });
    },
  );

  it('Kopfbeträge entsprechen der bisherigen Einzelsatz-Formel (300 Zufallsläufe)', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 300; run++) {
      const vatRate = [7, 19][run % 2]!;
      const entries = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, index) =>
        entry(
          `e${index}`,
          `2026-0${1 + Math.floor(random() * 9)}-1${index}T08:00:00Z`,
          1 + Math.floor(random() * 600),
          random() < 0.4 ? String(Math.round(random() * 30000) / 100) : null,
        ),
      );
      const hourlyRate = Math.round(random() * 25000) / 100;
      h.events = [];
      h.tx = makeTx({ entries });
      const strategy = run % 3 === 0 ? 'one-line' : 'per-entry';
      await expect(
        createInvoiceFromTimeEntriesAction({ ...TIME_INPUT, vatRate, hourlyRate, strategy }),
      ).resolves.toEqual({ ok: true, invoiceId: 'invoice-1' });

      // Bisherige Berechnung der Stundenabrechnung (vor dem gemeinsamen Service).
      const nets = entries.map((e) => {
        const minutes = Math.floor((e.endedAt.getTime() - e.startedAt.getTime()) / 60_000);
        const rate = e.hourlyRate ? Number(e.hourlyRate.toString()) : hourlyRate;
        return round2((minutes / 60) * rate);
      });
      const totalNet = round2(nets.reduce((sum, net) => sum + net, 0));
      const vatAmount = round2((totalNet * vatRate) / 100);
      const { data } = eventOf('create') as { data: Record<string, unknown> };
      expect({
        netAmount: data['netAmount'],
        vatAmount: data['vatAmount'],
        totalAmount: data['totalAmount'],
        vatRate: data['vatRate'],
      }).toEqual({
        netAmount: totalNet,
        vatAmount,
        totalAmount: round2(totalNet + vatAmount),
        vatRate,
      });
    }
  });

  it('Reverse-Charge ohne USt-IdNr der Kanzlei scheitert VOR der Nummernvergabe', async () => {
    h.seller = { vatId: null };
    h.tx = makeTx({ entries: ENTRIES });

    const result = await createInvoiceFromTimeEntriesAction({
      ...TIME_INPUT,
      vatRate: 0,
      reverseCharge: true,
      strategy: 'one-line',
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Reverse-Charge (§ 13b UStG) erfordert die USt-IdNr der Kanzlei (Einstellungen → Kanzlei-Stammdaten).',
    });
    expect(h.allocate).not.toHaveBeenCalled();
    expect(kinds()).toEqual(['access']);
  });

  it('Rechnungssumme über Decimal(12,2) scheitert VOR der Nummernvergabe', async () => {
    h.tx = makeTx({ entries: [entry('e1', '2026-09-01T09:00:00Z', 60 * 24 * 365, '99999.99')] });

    const result = await createInvoiceFromTimeEntriesAction({
      ...TIME_INPUT,
      strategy: 'one-line',
    });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('zu groß') });
    expect(h.allocate).not.toHaveBeenCalled();
  });
});

describe('StBVV-Übernahme über den Service – unveränderte Anlage', () => {
  function feeQuote(vatRate: 0 | 19) {
    const { input, result } = validateFeeCalculation({
      lawVersion: STBVV_VERSION,
      currentLawConfirmed: true,
      matterReviewConfirmed: true,
      lines: [
        {
          id: 'line',
          feeId: '24-1-1',
          matter: 'Erklärung 2025',
          rate: 3,
          rawValue: 54321,
          justification: 'Synthetische geprüfte Testeingabe.',
        },
        {
          id: 'time',
          feeId: '28',
          matter: 'Bescheid 2025',
          rate: 20,
          minutes: 31,
          justification: 'Bescheidprüfung im synthetischen Fall.',
        },
      ],
      expenses: [
        {
          id: 'post',
          matter: 'Erklärung 2025',
          kind: 'POST_PERCENT',
          justification: 'Pauschale nach § 16 synthetisch.',
        },
      ],
      vatRate,
      ...(vatRate === 0 ? { vatExemptionReason: '§ 4 Nr. 1 UStG' } : {}),
    });
    return {
      quote: {
        id: 'quote-1',
        title: 'Honorar 2025',
        lawVersion: STBVV_VERSION,
        inputs: input,
        result,
        invoiceExport: null,
      },
      result,
    };
  }

  it.each([19, 0] as const)(
    'USt %i %%: Nummer, Kopf, Positionen, Claim und Audit wie bisher',
    async (vatRate) => {
      const { quote, result } = feeQuote(vatRate);
      const tx = makeTx({ quote });

      await expect(
        createFeeInvoice(tx as never, TENANT, STAFF, CLIENT, 'quote-1', '2026-10-05', '2026-10-19'),
      ).resolves.toEqual({ invoiceId: 'invoice-1', existing: false });

      expect(kinds()).toEqual(['allocate', 'create', 'export', 'audit']);
      const lines = [...result.lines, ...result.expenses];
      expect(eventOf('create')).toEqual({
        data: {
          tenantId: TENANT,
          clientId: CLIENT,
          number: '2026-0042',
          subject: 'Honorar 2025',
          issueDate: new Date('2026-10-05'),
          dueDate: new Date('2026-10-19'),
          servicePeriodStart: null,
          servicePeriodEnd: null,
          vatExemptionReason: vatRate === 0 ? '§ 4 Nr. 1 UStG' : null,
          reverseCharge: false,
          status: 'DRAFT',
          format: 'XRECHNUNG',
          netAmount: result.netCents / 100,
          vatAmount: result.vatCents / 100,
          totalAmount: result.grossCents / 100,
          vatRate,
          notes: `Kalkulation quote-1 · ${STBVV_VERSION}. Fachlicher Entwurf; vor Versand Leistungszeitraum, Voraussetzungen, Vorschüsse und Angemessenheit prüfen.`,
          createdByStaff: STAFF,
          positions: {
            create: lines.map((line, index) => ({
              position: index + 1,
              description: expect.stringContaining(line.description),
              quantity: 1,
              unitPrice: line.netCents / 100,
              unit: 'Position',
              netAmount: line.netCents / 100,
              vatRate,
            })),
          },
        },
      });
      expect(eventOf('export')).toEqual({
        data: { tenantId: TENANT, quoteId: 'quote-1', invoiceId: 'invoice-1' },
      });
      expect(eventOf('audit')).toEqual({
        tenantId: TENANT,
        actorType: 'STAFF',
        actorId: STAFF,
        action: 'stbvv.invoice.draft',
        resourceType: 'invoice',
        resourceId: 'invoice-1',
        after: {
          clientId: CLIENT,
          quoteId: 'quote-1',
          number: '2026-0042',
          totalAmount: result.grossCents / 100,
        },
      });
    },
  );

  it('öffnet keinen fremden Jahres-Nummernkreis (Rechnungsjahr ± 1)', async () => {
    const { quote } = feeQuote(19);
    const tx = makeTx({ quote });
    await expect(
      createFeeInvoice(tx as never, TENANT, STAFF, CLIENT, 'quote-1', '2099-01-05', '2099-01-19'),
    ).rejects.toThrow('laufendes Jahr ± 1');
    expect(h.allocate).not.toHaveBeenCalled();
    expect(tx.stbvvQuoteExport.create).not.toHaveBeenCalled();
  });
});

describe('checkDraftInvoice', () => {
  it('nummeriert Positionen und rechnet Netto je Position auf Speicherpräzision', () => {
    const checked = checkDraftInvoice(HEADER, [
      { ...POSITION, quantity: 0.1, unitPrice: 0.05 },
      { ...POSITION, quantity: 1.23, unitPrice: 100 },
    ]);
    expect(checked).toMatchObject({
      ok: true,
      positions: [
        { position: 1, netAmount: 0.01 },
        { position: 2, netAmount: 123 },
      ],
      totals: { netAmount: 123.01, vatAmount: 23.37, totalAmount: 146.38, uniformRate: 19 },
    });
  });
});
