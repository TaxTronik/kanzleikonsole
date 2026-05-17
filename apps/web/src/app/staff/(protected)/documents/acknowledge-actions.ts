'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult { ok: boolean; error?: string; }

/**
 * „Empfangsbestätigung" eines Dokuments. Markiert nur, wer wann gesehen hat —
 * GoBD-Beweis, dass die Belege vorlagen.
 */
export async function acknowledgeDocumentAction(input: {
  documentId: string;
  acknowledged: boolean;
}): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({
    documentId: z.string().uuid(),
    acknowledged: z.boolean(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const doc = await tx.document.findUnique({
          where: { id: parsed.data.documentId },
          select: { id: true, title: true, clientId: true },
        });
        if (!doc) throw new Error('Dokument nicht gefunden.');

        await tx.document.update({
          where: { id: parsed.data.documentId },
          data: parsed.data.acknowledged
            ? { acknowledgedAt: new Date(), acknowledgedByStaff: staffId }
            : { acknowledgedAt: null, acknowledgedByStaff: null },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: parsed.data.acknowledged ? 'document.acknowledge' : 'document.unacknowledge',
          resourceType: 'document',
          resourceId: doc.id,
          after: { title: doc.title },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/documents');
  revalidatePath(`/staff/documents/${parsed.data.documentId}`);
  if (input.documentId) revalidatePath('/staff/clients', 'layout');
  return { ok: true };
}
