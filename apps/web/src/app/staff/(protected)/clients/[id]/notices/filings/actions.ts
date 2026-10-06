'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaffModule,
  ActionError,
  type ActionResult as BaseActionResult,
  type StaffCtx,
} from '@/server/actions/staff-action';
import { runJournaledUpload, uploadFailureCause } from '@/server/documents/journaled-upload';
import { readUploadFile } from '@/server/documents/upload-file';

const withTaxNoticesStaff = withStaffModule('taxNotices');

export interface ActionResult extends BaseActionResult {
  id?: string;
}

const KIND_VALUES = [
  'USTA',
  'UST_JAHR',
  'EST',
  'KST',
  'GEWST_MESSBESCHEID',
  'GEWST',
  'LSTA',
  'FESTSTELLUNG',
  'ZERLEGUNG',
  'SONSTIGE',
] as const;

const SaveSchema = z.object({
  filingId: z.string().uuid().nullable(),
  clientId: z.string().uuid(),
  kind: z.enum(KIND_VALUES),
  period: z.string().min(4).max(20),
  filingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  expectedAssessed: z.number().nullable(),
  expectedPrepaid: z.number().nullable(),
  expectedRefund: z.number().nullable(),
  expectedPay: z.number().nullable(),
  clientNote: z.string().max(5000).nullable(),
  internalNote: z.string().max(5000).nullable(),
});

/** Metadaten der Berechnungs-PDF (vom File, F-09). */
const FilingPdfMetaSchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
});

type SaveInput = z.infer<typeof SaveSchema>;

/**
 * Gemeinsame Vor- und Nachprüfung (K-06 / DOC-UPLOAD-JOURNAL-001): Zugriff,
 * Mandantenbindung einer bestehenden Erklärung und freier Zeitraum werden vor
 * dem irreversiblen Object-Lock-Write und erneut in der Commit-Transaktion
 * geprüft.
 */
async function checkTaxFilingTx(
  tx: TxClient,
  session: StaffCtx['session'],
  tenantId: string,
  data: SaveInput,
): Promise<void> {
  await assertClientAccessTx(tx, session, data.clientId);
  if (data.filingId) {
    const before = await tx.taxFiling.findUnique({
      where: { id: data.filingId },
      select: { clientId: true },
    });
    if (!before) throw new ActionError('Erklärung nicht gefunden.');
    if (before.clientId !== data.clientId) throw new ActionError('Mandant stimmt nicht.');
    return;
  }
  const existing = await tx.taxFiling.findUnique({
    where: {
      tenantId_clientId_kind_period: {
        tenantId,
        clientId: data.clientId,
        kind: data.kind,
        period: data.period,
      },
    },
    select: { id: true },
  });
  if (existing) throw new ActionError('Es gibt bereits eine Erklärung für diesen Zeitraum.');
}

/**
 * F-09: Die optionale Berechnungs-PDF kommt als `File` in `upload`
 * (FormData-Feld `pdf`), nicht als base64-String im Action-Body.
 */
export async function saveTaxFilingAction(
  input: z.infer<typeof SaveSchema>,
  upload?: FormData | null,
): Promise<ActionResult> {
  const g = await staffActionGuard({ module: 'taxNotices' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = SaveSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const data = parsed.data;

  let pdf: z.infer<typeof FilingPdfMetaSchema> | null = null;
  let fileData: Buffer | null = null;
  if (upload?.get('pdf') != null) {
    const read = await readUploadFile(upload, 'pdf', 'taxFilingPdf', { tooLarge: 'PDF zu groß' });
    if (!read.ok) return { ok: false, error: read.error };
    const meta = FilingPdfMetaSchema.safeParse({
      fileName: read.fileName,
      mimeType: read.mimeType || 'application/pdf',
    });
    if (!meta.success) return { ok: false, error: 'Dateiname oder Dateityp der PDF ist ungültig.' };
    pdf = meta.data;
    fileData = read.bytes;
  }

  const saveFilingTx = async (tx: TxClient, documentId?: string): Promise<string> => {
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
      // Mandantenbindung: assertClientAccessTx (oben) autorisiert die
      // MITGESENDETE data.clientId, das Update greift aber allein über
      // data.filingId. Ohne diesen Abgleich könnte ein Mitarbeiter mit
      // Zugriff auf Mandant A per bekannter filingId die Erklärung eines
      // fremden Mandanten B überschreiben (RLS trennt nur Tenants, nicht
      // Mandanten). Vgl. shareTaxFilingAction, die genau so bindet.
      if (before.clientId !== data.clientId) throw new ActionError('Mandant stimmt nicht.');
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
        tenantId_clientId_kind_period: {
          tenantId,
          clientId: data.clientId,
          kind: data.kind,
          period: data.period,
        },
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
  };

  let resultId: string;
  try {
    if (pdf && fileData) {
      const pdfBytes = fileData;
      const { result } = await runJournaledUpload({
        context: ctx,
        source: 'staff.tax_filing.pdf',
        check: (tx) => checkTaxFilingTx(tx, session, tenantId, data),
        readBytes: async () => pdfBytes,
        storage: () => ({ tier: 'GOBD', classification: 'GOBD_TAX' }),
        commitTx: async (tx, { commit: committed }) => {
          const doc = await tx.document.create({
            data: {
              tenantId,
              clientId: data.clientId,
              title: pdf.fileName,
              classification: 'GOBD_TAX',
              mimeType: committed.detectedMime ?? pdf.mimeType,
              retentionUntil: committed.retentionUntil,
            },
          });
          await tx.documentVersion.create({
            data: {
              documentId: doc.id,
              versionNo: 1,
              storageBucket: committed.targetBucket,
              storageKey: committed.targetKey,
              storageVersionId: committed.storageVersionId,
              sha256: prismaBytes(committed.sha256),
              sizeBytes: committed.sizeBytes,
              immutable: committed.immutable,
              scanStatus: 'CLEAN',
              scanCompletedAt: new Date(),
              createdById: staffId,
            },
          });
          return saveFilingTx(tx, doc.id);
        },
      });
      resultId = result;
    } else {
      resultId = await withTenantContext(ctx, async (tx) => {
        await checkTaxFilingTx(tx, session, tenantId, data);
        return saveFilingTx(tx);
      });
    }
  } catch (e) {
    // Nach dem Object-Write bleibt die Speicherabsicht offen; der Cleanup-Worker
    // räumt das Objekt nach der Sicherheitsfrist versionsgenau auf.
    return toActionError(uploadFailureCause(e));
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

  return withTaxNoticesStaff(
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
  const parsed = z
    .object({ filingId: z.string().uuid(), clientId: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withTaxNoticesStaff(
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
