'use server';

import { z } from 'zod';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';
import { saveTaxMasterDataTx } from '@/server/tax-master-data/service';
import type { TaxMasterSaveInput } from '@/components/tax-master-data-form';

export async function saveTaxMasterDataAction(input: TaxMasterSaveInput): Promise<ActionResult> {
  const parsed = z
    .object({ clientId: z.string().uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Ungültige Anfrage.' };
  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, parsed.data.clientId);
      await saveTaxMasterDataTx(tx, { ...parsed.data, tenantId, staffId, draft: input.draft });
    },
    {
      revalidate: [
        `/staff/clients/${input.clientId}`,
        `/staff/clients/${input.clientId}/edit`,
        `/staff/clients/${input.clientId}/elster`,
        '/portal/stammdaten',
      ],
    },
  );
}
