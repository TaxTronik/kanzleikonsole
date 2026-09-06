// Fachkatalog: STBVV-CALCULATION-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { STBVV_VERSION } from '@taxtronik/tax';
vi.mock('@/server/actions/staff-action', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/invoicing/number', () => ({
  allocateInvoiceNumber: vi.fn(async () => '2026-0001'),
}));
vi.mock('@/server/container', () => ({
  evidenceService: { record: vi.fn(async () => undefined) },
}));
import { createFeeInvoice, validateFeeCalculation } from '../service';
import { allocateInvoiceNumber } from '@/server/invoicing/number';
import { evidenceService } from '@/server/container';
import {
  toXRechnungInvoice,
  generateXRechnungCii,
  type StoredInvoiceForXRechnung,
} from '@/server/invoicing/xrechnung';
import { generateZugferdPdf, extractFacturXXml } from '@/server/invoicing/zugferd';
import { SAMPLE_SELLER, SAMPLE_BUYER } from '@/server/invoicing/sample-fixture';
import { extractText, getDocumentProxy } from 'unpdf';

describe('StBVV draft export and idempotent claim', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses the void-safe transaction lock before reusing an existing invoice without allocation', async () => {
    const events: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async () => {
        events.push('lock');
        return 1;
      }),
      $queryRaw: vi.fn(async () => {
        throw new Error('void cannot be deserialized');
      }),
      stbvvQuote: {
        findFirst: vi.fn(async () => {
          events.push('quote');
          return { invoiceExport: { invoiceId: 'existing' }, result: { lines: [] } };
        }),
      },
      invoice: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    await expect(
      createFeeInvoice(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'client',
        'quote',
        '2026-08-31',
        '2026-09-14',
      ),
    ).resolves.toEqual({ invoiceId: 'existing', existing: true });
    expect(events).toEqual(['lock', 'quote', 'lock']);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
    expect(evidenceService.record).not.toHaveBeenCalled();
  });
  it('creates one draft with matching totals and an immutable quote claim, then reuses it', async () => {
    const { input, result } = validateFeeCalculation({
      lawVersion: STBVV_VERSION,
      currentLawConfirmed: true,
      matterReviewConfirmed: true,
      lines: [
        {
          id: 'line',
          feeId: '24-1-1',
          matter: 'Synthetischer Auftrag 2026',
          rate: 1,
          rawValue: 10000,
          justification: 'Synthetischer Test einer fachlich geprüften Eingabe.',
        },
      ],
      expenses: [],
      vatRate: 19,
    });
    let claim: { invoiceId: string } | null = null;
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      stbvvQuote: {
        findFirst: vi.fn(async () => ({
          id: 'quote',
          title: 'Synthetic quote',
          lawVersion: STBVV_VERSION,
          inputs: input,
          result,
          invoiceExport: claim,
        })),
      },
      client: { findFirst: vi.fn(async () => ({ id: 'client' })) },
      invoice: {
        create: vi.fn(async () => ({ id: 'new-invoice' })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      stbvvQuoteExport: {
        create: vi.fn(async ({ data }: { data: { invoiceId: string } }) => {
          claim = data;
          return data;
        }),
      },
    };
    const run = () =>
      createFeeInvoice(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'client',
        'quote',
        '2026-08-31',
        '2026-09-14',
      );
    expect(await run()).toEqual({ invoiceId: 'new-invoice', existing: false });
    expect(await run()).toEqual({ invoiceId: 'new-invoice', existing: true });
    expect(tx.invoice.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        status: 'DRAFT',
        format: 'XRECHNUNG',
        createdByStaff: 'staff',
        clientId: 'client',
        tenantId: 'tenant',
        netAmount: result.netCents / 100,
        totalAmount: result.grossCents / 100,
      }),
    });
    expect(tx.stbvvQuoteExport.create).toHaveBeenCalledExactlyOnceWith({
      data: { tenantId: 'tenant', quoteId: 'quote', invoiceId: 'new-invoice' },
    });
    expect(allocateInvoiceNumber).toHaveBeenCalledOnce();
    expect(evidenceService.record).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'unissued empty PDF draft', overrides: {}, repair: true },
    ...['SENT', 'PAID', 'OVERDUE', 'CANCELLED'].map((status) => ({
      label: status,
      overrides: { status },
      repair: false,
    })),
    { label: 'draft with sentAt', overrides: { sentAt: new Date('2026-09-06') }, repair: false },
    { label: 'draft with PDF document', overrides: { documentId: 'pdf' }, repair: false },
    { label: 'draft with XML document', overrides: { xrechnungDocumentId: 'xml' }, repair: false },
    { label: 'supported draft format', overrides: { format: 'XRECHNUNG' }, repair: false },
  ])('repairs only the legacy empty PDF draft: $label', async ({ overrides, repair }) => {
    const stored: Record<string, unknown> = {
      id: 'existing',
      tenantId: 'tenant',
      clientId: 'client',
      status: 'DRAFT',
      sentAt: null,
      format: 'PDF',
      documentId: null,
      xrechnungDocumentId: null,
      ...overrides,
    };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      stbvvQuote: {
        findFirst: vi.fn(async () => ({
          invoiceExport: { invoiceId: 'existing' },
          result: { lines: [] },
        })),
      },
      invoice: {
        updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
          count: Object.entries(where).every(([key, value]) => stored[key] === value) ? 1 : 0,
        })),
      },
    };
    await expect(
      createFeeInvoice(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'client',
        'quote',
        '2026-09-06',
        '2026-09-20',
      ),
    ).resolves.toEqual({ invoiceId: 'existing', existing: true });
    expect(tx.invoice.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'existing',
        tenantId: 'tenant',
        clientId: 'client',
        status: 'DRAFT',
        sentAt: null,
        format: 'PDF',
        documentId: null,
        xrechnungDocumentId: null,
      },
      data: { format: 'XRECHNUNG' },
    });
    expect(evidenceService.record).toHaveBeenCalledTimes(repair ? 1 : 0);
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'STBVV-CALCULATION-001: renders time-fee CII and complete readable PDF (legacy repair: %s)',
    async (legacy) => {
      const { input, result } = validateFeeCalculation({
        lawVersion: STBVV_VERSION,
        currentLawConfirmed: true,
        matterReviewConfirmed: true,
        lines: [
          {
            id: 'line',
            feeId: '28',
            matter: 'Bescheid 2026',
            rate: 20,
            minutes: 31,
            justification: 'Bescheidprüfung im synthetischen Integrationsfall.',
          },
        ],
        expenses: [],
        vatRate: 19,
      });
      // Independent control: 31 minutes = three started quarters, each EUR 20.
      expect(result.netCents).toBe(6000);
      expect(result.lines[0]!.trace.join(' ')).toContain('→');
      let saved: StoredInvoiceForXRechnung | undefined;
      const tx = {
        $executeRaw: vi.fn(async () => 1),
        stbvvQuote: {
          findFirst: vi.fn(async () => ({
            id: 'quote',
            title: 'Honorar',
            lawVersion: STBVV_VERSION,
            inputs: input,
            result,
            invoiceExport: null,
          })),
        },
        client: { findFirst: vi.fn(async () => ({ id: 'client' })) },
        invoice: {
          create: vi.fn(
            async ({
              data,
            }: {
              data: StoredInvoiceForXRechnung & {
                positions: { create: StoredInvoiceForXRechnung['positions'] };
              };
            }) => {
              saved = {
                ...data,
                stornoOfId: null,
                servicePeriodStart: null,
                servicePeriodEnd: null,
                reverseCharge: false,
                positions: data.positions.create,
              };
              return { id: 'invoice' };
            },
          ),
        },
        stbvvQuoteExport: { create: vi.fn(async () => ({})) },
      };
      await createFeeInvoice(
        tx as unknown as TxClient,
        'tenant',
        'staff',
        'client',
        'quote',
        '2026-09-06',
        '2026-09-20',
      );
      if (legacy) {
        const legacyDescription = saved!.positions[0]!.description.replace(
          '31 Minuten ergibt ',
          '31 Minuten → ',
        );
        saved!.positions[0]!.description = legacyDescription;
        const updatePosition = vi.fn(
          async ({
            where,
            data,
          }: {
            where: { invoiceId: string; position: number; description: string };
            data: { description: string };
          }) => {
            if (where.description !== saved!.positions[0]!.description) return { count: 0 };
            saved!.positions[0]!.description = data.description;
            return { count: 1 };
          },
        );
        const repairTx = {
          ...tx,
          stbvvQuote: {
            findFirst: vi.fn(async () => ({ result, invoiceExport: { invoiceId: 'invoice' } })),
          },
          invoice: { updateMany: vi.fn(async () => ({ count: 1 })) },
          invoicePosition: { updateMany: updatePosition },
        };
        expect(
          await createFeeInvoice(
            repairTx as unknown as TxClient,
            'tenant',
            'staff',
            'client',
            'quote',
            '2026-09-06',
            '2026-09-20',
          ),
        ).toEqual({ invoiceId: 'invoice', existing: true });
        expect(updatePosition).toHaveBeenCalledWith({
          where: { invoiceId: 'invoice', position: 1, description: legacyDescription },
          data: { description: expect.stringContaining('31 Minuten ergibt ') },
        });
        expect(allocateInvoiceNumber).toHaveBeenCalledOnce();
      }
      const invoice = toXRechnungInvoice(saved!);
      const xml = generateXRechnungCii(invoice, SAMPLE_SELLER, SAMPLE_BUYER);
      const bytes = await generateZugferdPdf(invoice, SAMPLE_SELLER, SAMPLE_BUYER, xml);
      expect(await extractFacturXXml(bytes)).toEqual(Buffer.from(xml));
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      expect(text.replace(/\s/g, '')).toContain(
        invoice.positions[0]!.description.replace(/\s/g, ''),
      );
      expect(xml).toContain('<ram:GrandTotalAmount>71.40</ram:GrandTotalAmount>');
      expect(result.lines[0]!.trace.join(' ')).toContain('→');
    },
  );
});
