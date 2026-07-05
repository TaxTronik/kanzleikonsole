'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { commitDocumentFromBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, withStaff, ActionError, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export interface ActionResult extends BaseActionResult {
  id?: string;
}

const KIND_VALUES = [
  'USTA', 'UST_JAHR', 'EST', 'KST', 'GEWST_MESSBESCHEID', 'GEWST',
  'LSTA', 'FESTSTELLUNG', 'ZERLEGUNG', 'SONSTIGE',
] as const;

const SaveSchema = z.object({
  filingId: z.string().uuid().nullable(),
  clientId: z.string().uuid(),
  kind: z.enum(KIND_VALUES),
  period: z.string().min(4).max(20),
  filingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expectedAssessed: z.number().nullable(),
  expectedPrepaid: z.number().nullable(),
  expectedRefund: z.number().nullable(),
  expectedPay: z.number().nullable(),
  clientNote: z.string().max(5000).nullable(),
  internalNote: z.string().max(5000).nullable(),
  pdf: z
    .object({
      fileName: z.string().min(1).max(200),
      mimeType: z.string().min(1).max(100),
      base64: z.string().min(1).max(20 * 1024 * 1024),
    })
    .nullable()
    .optional(),
});

export async function saveTaxFilingAction(
  input: z.infer<typeof SaveSchema>,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const data = parsed.data;

  // PDF optional vorab ablegen (vor TX, ClamAV-Scan etc.)
  let documentId: string | undefined;
  if (data.pdf) {
    const fileData = Buffer.from(data.pdf.base64, 'base64');
    if (fileData.length > 10 * 1024 * 1024) {
      return { ok: false, error: 'PDF zu groß (max. 10 MB).' };
    }
    const stored = await commitDocumentFromBytes({ fileData, classification: 'GOBD_TAX', tenantId });
    try {
      documentId = await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, data.clientId);
        const doc = await tx.document.create({
        data: {
          tenantId,
          clientId: data.clientId,
          title: data.pdf!.fileName,
          classification: 'GOBD_TAX',
          // P-3: Magic-Bytes statt Client-Header — siehe M-2.
          mimeType: stored.detectedMime ?? data.pdf!.mimeType,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: stored.targetBucket,
          storageKey: stored.targetKey,
          sha256: prismaBytes(stored.sha256),
          sizeBytes: stored.sizeBytes,
          immutable: stored.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      });
      return doc.id;
      });
    } catch (e) {
      return toActionError(e);
    }
  }

  let resultId: string;
  try {
    resultId = await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, data.clientId);
      const baseData = {
        kind: data.kind,
        period: data.period,
        filingDate: data.filingDate ? new Date(data.filingDate) : null,
        expectedAssessed: data.expectedAssessed,
        expectedPrepaid: data.expectedPrepaid,
        expectedRefund: data.expectedRefund,
        expectedPay: data.expectedPay,
        clientNote: data.clientNote?.trim() || null,
        internalNote: data.internalNote?.trim() || null,
      };

      if (data.filingId) {
        const before = await tx.taxFiling.findUnique({ where: { id: data.filingId } });
        if (!before) throw new ActionError('Erklärung nicht gefunden.');
        await tx.taxFiling.update({
          where: { id: data.filingId },
          data: { ...baseData, ...(documentId ? { documentId } : {}) },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'tax_filing.update',
          resourceType: 'tax_filing',
          resourceId: data.filingId,
          before,
          after: baseData,
        });
        return data.filingId;
      }

      // Auf vorhandene Erklärung für (client, kind, period) prüfen
      const existing = await tx.taxFiling.findUnique({
        where: {
          tenantId_clientId_kind_period: { tenantId, clientId: data.clientId, kind: data.kind, period: data.period },
        },
      });
      if (existing) {
        throw new ActionError('Es gibt bereits eine Erklärung für diesen Zeitraum.');
      }

      const created = await tx.taxFiling.create({
        data: {
          tenantId,
          clientId: data.clientId,
          ...baseData,
          documentId: documentId ?? null,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_filing.create',
        resourceType: 'tax_filing',
        resourceId: created.id,
        after: { ...baseData, clientId: data.clientId },
      });
      return created.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath(`/staff/clients/${data.clientId}/notices`);
  return { ok: true, id: resultId };
}

const ShareSchema = z.object({
  filingId: z.string().uuid(),
  clientId: z.string().uuid(),
  share: z.boolean(),
});

export async function shareTaxFilingAction(
  input: z.infer<typeof ShareSchema>,
): Promise<ActionResult> {
  const parsed = ShareSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { filingId, clientId, share } = parsed.data;

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const filing = await tx.taxFiling.findUnique({ where: { id: filingId } });
      if (!filing) throw new ActionError('Erklärung nicht gefunden.');
      if (filing.clientId !== clientId) throw new ActionError('Mandant stimmt nicht.');
      await assertClientAccessTx(tx, session, filing.clientId);

      await tx.taxFiling.update({
        where: { id: filingId },
        data: share
          ? { sharedWithClient: true, sharedAt: new Date(), sharedBy: staffId }
          : { sharedWithClient: false },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: share ? 'tax_filing.share' : 'tax_filing.unshare',
        resourceType: 'tax_filing',
        resourceId: filingId,
        after: { kind: filing.kind, period: filing.period },
      });
    },
    { revalidate: [`/staff/clients/${clientId}/notices`, '/portal/dashboard', '/portal/steuer'] },
  );
}

export async function deleteTaxFilingAction(input: {
  filingId: string;
  clientId: string;
}): Promise<ActionResult> {
  const parsed = z.object({ filingId: z.string().uuid(), clientId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const filing = await tx.taxFiling.findUnique({ where: { id: parsed.data.filingId } });
      if (!filing) throw new ActionError('Erklärung nicht gefunden.');
      await assertClientAccessTx(tx, session, filing.clientId);
      await tx.taxFiling.delete({ where: { id: parsed.data.filingId } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_filing.delete',
        resourceType: 'tax_filing',
        resourceId: parsed.data.filingId,
        before: { kind: filing.kind, period: filing.period },
      });
    },
    { revalidate: `/staff/clients/${parsed.data.clientId}/notices` },
  );
}
