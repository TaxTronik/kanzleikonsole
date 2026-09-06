import { z } from 'zod';
import type { TxClient } from '@taxtronik/db';
import {
  calculateStbvv,
  FeeInputError,
  STBVV_VERSION,
  type FeeCalculation,
  type FeeCalculationInput,
} from '@taxtronik/tax';
import { screeningJson } from '@taxtronik/tax/screening/persistence';
import { ActionError } from '@/server/actions/staff-action';
import { computeVatTotals } from '@/server/invoicing/vat';
import { allocateInvoiceNumber } from '@/server/invoicing/number';
import { evidenceService } from '@/server/container';
import { lockFeeQuoteExportTx } from './lock';
import { lockInvoiceArchiveTx } from '@/server/invoicing/archive-lock';
const number = z.number().finite().nonnegative();
const line = z
  .object({
    id: z.string().min(1).max(100),
    feeId: z.string().min(1).max(40),
    matter: z.string().min(1).max(160),
    rate: number,
    rawValue: z.number().finite().optional(),
    weightedHectares: number.optional(),
    quantity: number.optional(),
    minutes: number.optional(),
    consumerFirstConsultation: z.boolean().optional(),
    nonNaturalPerson: z.boolean().optional(),
    manualAmount: number.optional(),
    justification: z.string().min(10).max(4000),
    creditFromLineId: z.string().max(100).optional(),
  })
  .strict();
const expense = z
  .object({
    id: z.string().min(1).max(100),
    matter: z.string().min(1).max(160),
    kind: z.enum([
      'POST_PERCENT',
      'POST_ACTUAL',
      'DOCUMENTS',
      'ELECTRONIC_DOCUMENTS',
      'TRAVEL_KM',
      'ABSENCE',
      'ACTUAL',
    ]),
    justification: z.string().min(10).max(4000),
    amount: number.optional(),
    pagesBw: number.optional(),
    pagesColor: number.optional(),
    files: number.optional(),
    scanEquivalentCents: number.optional(),
    km: number.optional(),
    hours: number.optional(),
    foreignUplift: z.boolean().optional(),
  })
  .strict();
const calculation = z
  .object({
    lawVersion: z.literal(STBVV_VERSION),
    currentLawConfirmed: z.literal(true),
    matterReviewConfirmed: z.literal(true),
    lines: z.array(line).min(1).max(100),
    expenses: z.array(expense).max(100),
    vatRate: z.union([z.literal(0), z.literal(19)]),
    vatExemptionReason: z.string().max(500).optional(),
  })
  .strict();
export function validateFeeCalculation(raw: unknown): {
  input: FeeCalculationInput;
  result: FeeCalculation;
} {
  const parsed = calculation.safeParse(raw);
  if (!parsed.success)
    throw new ActionError(
      'Kalkulationsdaten unvollständig oder ungültig. Rechtsstand und fachliche Prüfungen bestätigen.',
    );
  try {
    return { input: parsed.data, result: calculateStbvv(parsed.data) };
  } catch (e) {
    if (e instanceof FeeInputError) throw new ActionError(e.message);
    throw e;
  }
}
function feeLineDescription(l: FeeCalculation['lines'][number], legacy = false): string {
  const generatedTrace = l.trace.join(' ');
  const trace = legacy ? generatedTrace : generatedTrace.replaceAll('→', 'ergibt');
  return `${l.description} · ${l.provision} · ${l.matter}\n${l.value === null ? '' : `Gegenstandswert: ${l.value} EUR; `}${l.rate}/${l.denominator}; Anzahl ${l.quantity}; Gebühr vor Anrechnung ${(l.beforeCreditCents / 100).toFixed(2)} EUR; Anrechnung ${(l.creditCents / 100).toFixed(2)} EUR.\n${trace}\n${l.source}`;
}

async function repairLegacyFeeDescriptions(
  tx: TxClient,
  invoiceId: string,
  result: FeeCalculation,
): Promise<number> {
  let repaired = 0;
  for (const [index, line] of result.lines.entries()) {
    const before = feeLineDescription(line, true);
    const after = feeLineDescription(line);
    if (before === after) continue;
    const updated = await tx.invoicePosition.updateMany({
      // Exact old generated text only: never replace arbitrary user text.
      where: { invoiceId, position: index + 1, description: before },
      data: { description: after },
    });
    repaired += updated.count;
  }
  return repaired;
}

export async function createFeeInvoice(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
  quoteId: string,
  issueDate: string,
  dueDate: string,
) {
  await lockFeeQuoteExportTx(tx, quoteId);
  const quote = await tx.stbvvQuote.findFirst({
    where: { id: quoteId, tenantId, clientId },
    include: { invoiceExport: true },
  });
  if (!quote) throw new ActionError('Kalkulation nicht gefunden.');
  if (quote.invoiceExport) {
    const invoiceId = quote.invoiceExport.invoiceId;
    // STBVV-CALCULATION-001 / INV-LIFECYCLE-FREEZE-001: Nur den alten,
    // beleglosen PDF-Entwurf reparieren. Archivierung und Versand teilen
    // denselben Lock; der CAS schließt bereits ausgestellte Belege aus.
    await lockInvoiceArchiveTx(tx, invoiceId);
    const repaired = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        tenantId,
        clientId,
        status: 'DRAFT',
        sentAt: null,
        format: 'PDF',
        documentId: null,
        xrechnungDocumentId: null,
      },
      data: { format: 'XRECHNUNG' },
    });
    if (repaired.count > 0) {
      const repairedDescriptions = await repairLegacyFeeDescriptions(
        tx,
        invoiceId,
        quote.result as unknown as FeeCalculation,
      );
      await evidenceService.record(tx, {
        tenantId,
        actorId: staffId,
        actorType: 'STAFF',
        action: 'stbvv.invoice.draft',
        resourceType: 'invoice',
        resourceId: invoiceId,
        before: { format: 'PDF' },
        after: {
          clientId,
          quoteId,
          format: 'XRECHNUNG',
          repairedDraftFormat: true,
          repairedDescriptions,
        },
      });
    }
    return { invoiceId, existing: true };
  }
  const client = await tx.client.findFirst({
    where: { tenantId, id: clientId, allowActive: true, anonymizedAt: null, mandateEndedAt: null },
    select: { id: true },
  });
  if (!client) throw new ActionError('Mandat ist nicht aktiv oder beendet.');
  const result = quote.result as unknown as FeeCalculation,
    input = quote.inputs as unknown as FeeCalculationInput;
  if (result.lawVersion !== quote.lawVersion)
    throw new ActionError('Rechtsstand des gespeicherten Nachweises ist inkonsistent.');
  const positions = [
    ...result.lines.map((l) => ({
      description: feeLineDescription(l),
      net: l.netCents,
    })),
    ...result.expenses.map((e) => ({
      description: `Auslagen · ${e.matter} · ${e.description}`,
      net: e.netCents,
    })),
  ].map((p, i) => ({
    position: i + 1,
    description: p.description,
    quantity: 1,
    unitPrice: p.net / 100,
    unit: 'Position',
    netAmount: p.net / 100,
    vatRate: input.vatRate,
  }));
  const totals = computeVatTotals(positions);
  if (Math.round(totals.totalAmount * 100) !== result.grossCents)
    throw new ActionError('Rechnungssummen weichen vom Nachweis ab. Übernahme gesperrt.');
  const number = await allocateInvoiceNumber(tx, tenantId, new Date(issueDate));
  const invoice = await tx.invoice.create({
    data: {
      tenantId,
      clientId,
      number,
      subject: quote.title,
      issueDate: new Date(issueDate),
      dueDate: new Date(dueDate),
      status: 'DRAFT',
      // STBVV-CALCULATION-001: Der In-App-Entwurf muss den regulären
      // Archiv-/Versandpfad nutzen können; PDF ist nur für externe Uploads.
      format: 'XRECHNUNG',
      netAmount: totals.netAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      vatRate: input.vatRate,
      vatExemptionReason: input.vatExemptionReason || null,
      notes: `Kalkulation ${quote.id} · ${quote.lawVersion}. Fachlicher Entwurf; vor Versand Leistungszeitraum, Voraussetzungen, Vorschüsse und Angemessenheit prüfen.`,
      createdByStaff: staffId,
      positions: { create: positions },
    },
  });
  await tx.stbvvQuoteExport.create({ data: { tenantId, quoteId, invoiceId: invoice.id } });
  await evidenceService.record(tx, {
    tenantId,
    actorId: staffId,
    actorType: 'STAFF',
    action: 'stbvv.invoice.draft',
    resourceType: 'invoice',
    resourceId: invoice.id,
    after: { clientId, quoteId, number, totalAmount: totals.totalAmount },
  });
  return { invoiceId: invoice.id, existing: false };
}
export { screeningJson as feeJson };
