'use server';
import { z } from 'zod';
import { withStaff, ActionError } from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import { createFeeInvoice, validateFeeCalculation, feeJson } from '@/server/stbvv/service';
import { evidenceService } from '@/server/container';
export async function saveStbvvQuoteAction(clientId: string, title: string, raw: unknown) {
  return withStaff(
    async (tx, g) => {
      await assertClientAccessTx(tx, g.session, z.uuid().parse(clientId));
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
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorId: g.staffId,
        actorType: 'STAFF',
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
      await assertClientAccessTx(tx, g.session, z.uuid().parse(clientId));
      const modules = await readModules(g.ctx);
      if (modules.invoiceMode !== 'IN_APP')
        throw new ActionError('Übernahme ist nur im Rechnungsmodus IN_APP verfügbar.');
      const dates = z
        .object({ issueDate: z.iso.date(), dueDate: z.iso.date() })
        .safeParse({ issueDate, dueDate });
      if (!dates.success || dueDate < issueDate)
        throw new ActionError('Rechnungsdatum und Fälligkeit sind ungültig.');
      return createFeeInvoice(
        tx,
        g.tenantId,
        g.staffId,
        clientId,
        z.uuid().parse(quoteId),
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
