'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import {
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { assertClientAccessTx } from '@/server/auth/rbac';

export type ActionResult = BaseActionResult;

/**
 * „Empfangsbestätigung" eines Dokuments. Markiert nur, wer wann gesehen hat —
 * GoBD-Beweis, dass die Belege vorlagen.
 */
export async function acknowledgeDocumentAction(input: {
  documentId: string;
  acknowledged: boolean;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      documentId: z.string().uuid(),
      acknowledged: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const doc = await tx.document.findUnique({
      where: { id: parsed.data.documentId },
      select: { id: true, title: true, clientId: true },
    });
    if (!doc) throw new ActionError('Dokument nicht gefunden.');
    if (doc.clientId) await assertClientAccessTx(tx, session, doc.clientId);

    await tx.document.update({
      where: { id: parsed.data.documentId },
      data: parsed.data.acknowledged
        ? { acknowledgedAt: new Date(), acknowledgedByStaff: staffId }
        : { acknowledgedAt: null, acknowledgedByStaff: null },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: parsed.data.acknowledged ? 'document.acknowledge' : 'document.unacknowledge',
      resourceType: 'document',
      resourceId: doc.id,
      after: { title: doc.title },
    });
  });

  if (r.ok) {
    revalidatePath('/staff/documents');
    revalidatePath(`/staff/documents/${parsed.data.documentId}`);
    revalidatePath('/staff/clients', 'layout');
  }
  return r;
}
