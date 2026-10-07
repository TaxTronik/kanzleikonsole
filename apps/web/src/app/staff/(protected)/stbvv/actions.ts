'use server';
import { z } from 'zod';
import { withStaff, ActionError, requireUuidParam } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { readModulesTx } from '@/server/settings/modules';
import { dueDateError, INVOICE_DATES_INVALID } from '@/server/invoicing/create-draft';
import { createFeeInvoice, validateFeeCalculation, feeJson } from '@/server/stbvv/service';
import { audit } from '@/server/actions/audit';
export async function saveStbvvQuoteAction(clientId: string, title: string, raw: unknown) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(
        tx,
        g.session,
        requireUuidParam(clientId, 'Mandant nicht gefunden.'),
      );
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: g.tenantId, anonymizedAt: null, mandateEndedAt: null },
        select: { id: true },
      });
      if (!client) throw new ActionError('Mandat ist beendet oder nicht verfügbar.');
      const parsedTitle = z.string().trim().min(3).max(200).safeParse(title);
      if (!parsedTitle.success) throw new ActionError('Bezeichnung muss 3–200 Zeichen enthalten.');
      const { input, result } = validateFeeCalculation(raw);
      const quote = await tx.stbvvQuote.create({
        data: {
          tenantId: g.tenantId,
          clientId,
          title: parsedTitle.data,
          lawVersion: result.lawVersion,
          inputs: feeJson(input),
          result: feeJson(result),
          createdBy: g.staffId,
        },
      });
      await audit(tx, g, {
        action: 'stbvv.quote.create',
        resourceType: 'stbvv_quote',
        resourceId: quote.id,
        after: { clientId, lawVersion: result.lawVersion, netCents: result.netCents },
      });
      return { quoteId: quote.id };
    },
    {
      module: 'feeCalculator',
      requirePermission: 'INVOICE_MANAGE',
      revalidate: `/staff/clients/${clientId}/stbvv`,
    },
  );
}
export async function createStbvvDraftAction(
  clientId: string,
  quoteId: string,
  issueDate: string,
  dueDate: string,
) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(
        tx,
        g.session,
        requireUuidParam(clientId, 'Mandant nicht gefunden.'),
      );
      const modules = await readModulesTx(tx, g.tenantId);
      if (modules.invoiceMode !== 'IN_APP')
        throw new ActionError('Übernahme ist nur im Rechnungsmodus IN_APP verfügbar.');
      const dates = z
        .object({ issueDate: z.iso.date(), dueDate: z.iso.date() })
        .safeParse({ issueDate, dueDate });
      // INV-NUMBER-ALLOCATION-001: dieselbe Fälligkeitsprüfung und Meldung wie alle
      // Anlagepfade (der Anlageservice prüft sie erneut).
      if (!dates.success || dueDateError(new Date(issueDate), new Date(dueDate)))
        throw new ActionError(INVOICE_DATES_INVALID);
      return createFeeInvoice(
        tx,
        g.tenantId,
        g.staffId,
        clientId,
        requireUuidParam(quoteId, 'Honorarangebot nicht gefunden.'),
        issueDate,
        dueDate,
      );
    },
    {
      module: 'feeCalculator',
      requirePermission: 'INVOICE_MANAGE',
      revalidate: [`/staff/clients/${clientId}/stbvv`, '/staff/invoices'],
    },
  );
}
