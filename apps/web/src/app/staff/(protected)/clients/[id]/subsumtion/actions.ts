'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  requireSubsumtionAccess,
  ForbiddenError,
  toActionError,
  type ActionErrorResult,
} from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { getClientIp } from '@/server/rate-limit';
import { readModules } from '@/server/settings/modules';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import {
  runDeterministicAnalysis,
  updateMarking,
  addManualMarking,
  deleteMarking,
  delegateMarking,
  pushDefinitionToCatalog,
  extractText,
  UnsupportedDocumentTypeError,
  type RiskStatus,
} from '@/server/risk';
import { enqueueRiskAnalyseLlm } from '@/server/jobs/risk-analyse-queue';

type OkActionResult<T = unknown> = ({ ok: true } & T) | ActionErrorResult;

// Gemeinsamer Guard: Zugang (Admin/Partner oder zuständig) + aktives Modul.
async function guard(clientId: string): Promise<{ ctx: TenantContext; staffId: string }> {
  const session = await requireSubsumtionAccess(clientId);
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  const modules = await readModules(ctx);
  if (!modules.risk) throw new ForbiddenError('Das Subsumtions-Modul ist für diese Kanzlei deaktiviert.');
  return { ctx, staffId };
}

function requireEngine(): void {
  if (!isRiskLayerConfigured()) {
    throw new Error('Die Risk-Engine ist nicht konfiguriert — Analyse derzeit nicht möglich.');
  }
}

const AnalyzeSchema = z.object({
  clientId: z.string().uuid(),
  text: z.string().min(1, 'Bitte einen Sachverhalt eingeben.').max(200_000),
  title: z.string().max(200).optional(),
});

export async function analyzeAction(
  input: z.infer<typeof AnalyzeSchema>,
): Promise<OkActionResult<{ analysisId: string; markingCount: number }>> {
  try {
    const parsed = AnalyzeSchema.parse(input);
    const { ctx, staffId } = await guard(parsed.clientId);
    requireEngine();
    const res = await runDeterministicAnalysis(ctx, {
      text: parsed.text,
      title: parsed.title?.trim() || null,
      clientId: parsed.clientId,
      staffId,
    });
    revalidatePath(`/staff/clients/${parsed.clientId}/subsumtion`);
    return { ok: true, analysisId: res.analysisId, markingCount: res.markingCount };
  } catch (e) {
    return toActionError(e);
  }
}

export async function requestLlmAction(input: {
  clientId: string;
  analysisId: string;
  sourceText: string;
}): Promise<OkActionResult> {
  try {
    const { ctx } = await guard(input.clientId);
    requireEngine();
    await enqueueRiskAnalyseLlm({
      tenantId: ctx.tenantId,
      analysisId: input.analysisId,
      sourceText: input.sourceText,
    });
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const ManualMarkingSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  matchedText: z.string().min(1),
  begriff: z.string().min(1).max(200),
  farbe: z.string().max(20).nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  notiz: z.string().max(4000).nullable().optional(),
  normAnker: z.array(z.string().max(200)).max(50).optional(),
});

export async function addManualMarkingAction(
  input: z.infer<typeof ManualMarkingSchema>,
): Promise<OkActionResult<{ markingId: string }>> {
  try {
    const parsed = ManualMarkingSchema.parse(input);
    if (parsed.end <= parsed.start) return { ok: false, error: 'Ungültige Markierung.' };
    const { ctx } = await guard(parsed.clientId);
    const res = await addManualMarking(ctx, parsed);
    revalidatePath(`/staff/clients/${parsed.clientId}/subsumtion/${parsed.analysisId}`);
    return { ok: true, markingId: res.markingId };
  } catch (e) {
    return toActionError(e);
  }
}

const UpdateMarkingSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  markingId: z.string().uuid(),
  governanceTyp: z.enum(['FP', 'FF', 'IN']).nullable().optional(),
  schadensintensitaet: z.enum(['NIEDRIG', 'MITTEL', 'HOCH']).nullable().optional(),
  wahrscheinlichkeit: z.enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG']).nullable().optional(),
  kaskadenreichweite: z.number().int().min(0).max(99).nullable().optional(),
  kontrolle: z.string().max(2000).nullable().optional(),
  status: z.enum(['OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT']).optional(),
  notiz: z.string().max(4000).nullable().optional(),
  verantwortlichId: z.string().uuid().nullable().optional(),
  farbe: z.string().max(20).nullable().optional(),
  label: z.string().max(100).nullable().optional(),
});

export async function updateMarkingAction(
  input: z.infer<typeof UpdateMarkingSchema>,
): Promise<OkActionResult> {
  try {
    const { clientId, analysisId, markingId, ...fields } = UpdateMarkingSchema.parse(input);
    const { ctx } = await guard(clientId);
    await updateMarking(ctx, markingId, fields as { status?: RiskStatus });
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function deleteMarkingAction(input: {
  clientId: string;
  analysisId: string;
  markingId: string;
}): Promise<OkActionResult> {
  try {
    const { ctx } = await guard(input.clientId);
    await deleteMarking(ctx, input.markingId);
    revalidatePath(`/staff/clients/${input.clientId}/subsumtion/${input.analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const DelegateSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  markingId: z.string().uuid(),
  assigneeStaffId: z.string().uuid(),
  dueDate: z.string().optional(),
  notes: z.string().max(4000).optional(),
});

export async function delegateAction(
  input: z.infer<typeof DelegateSchema>,
): Promise<OkActionResult<{ reminderId: string }>> {
  try {
    const parsed = DelegateSchema.parse(input);
    const { ctx, staffId } = await guard(parsed.clientId);
    const res = await delegateMarking(ctx, {
      markingId: parsed.markingId,
      createdByStaffId: staffId,
      assigneeStaffId: parsed.assigneeStaffId,
      dueDate: parsed.dueDate ? new Date(parsed.dueDate) : undefined,
      notes: parsed.notes,
    });
    revalidatePath(`/staff/clients/${parsed.clientId}/subsumtion/${parsed.analysisId}`);
    return { ok: true, reminderId: res.reminderId };
  } catch (e) {
    return toActionError(e);
  }
}

const PushDefinitionSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  markingId: z.string().uuid(),
  begriff: z.string().min(1).max(200),
  definition: z.string().min(1).max(8000),
  normAnker: z.array(z.string()).optional(),
  scope: z.string().max(100).optional(),
});

export async function pushDefinitionAction(
  input: z.infer<typeof PushDefinitionSchema>,
): Promise<OkActionResult<{ begriffId: string }>> {
  try {
    const parsed = PushDefinitionSchema.parse(input);
    const { ctx } = await guard(parsed.clientId);
    requireEngine();
    const res = await pushDefinitionToCatalog(ctx, parsed);
    revalidatePath(`/staff/clients/${parsed.clientId}/subsumtion/${parsed.analysisId}`);
    return { ok: true, begriffId: res.begriffId };
  } catch (e) {
    return toActionError(e);
  }
}

const ImportDocSchema = z.object({ clientId: z.string().uuid(), documentId: z.string().uuid() });

/** Holt ein vorhandenes Mandanten-Dokument aus dem Object-Store (SeaweedFS) und
 *  extrahiert den Text. Der Zugriff wird wie ein Download auditiert. */
export async function importClientDocAction(
  input: z.infer<typeof ImportDocSchema>,
): Promise<OkActionResult<{ text: string }>> {
  try {
    const parsed = ImportDocSchema.parse(input);
    const { ctx, staffId } = await guard(parsed.clientId);
    const h = await headers();
    const ip = getClientIp(h);
    const userAgent = h.get('user-agent');

    const doc = await withTenantContext(ctx, async (tx) => {
      // Defense in Depth: expliziter Tenant-/Client-Filter zusätzlich zu RLS.
      const d = await tx.document.findFirst({
        where: { id: parsed.documentId, clientId: parsed.clientId, tenantId: ctx.tenantId, deletedAt: null },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      });
      const v = d?.versions[0];
      if (!d || !v) return null;
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.text_extract',
        resourceType: 'document',
        resourceId: d.id,
        ip,
        userAgent,
      });
      return { mimeType: d.mimeType, bucket: v.storageBucket, key: v.storageKey };
    });
    if (!doc) return { ok: false, error: 'Dokument nicht gefunden.' };

    // App-proxied: Bytes intern aus SeaweedFS holen (Store nie öffentlich).
    const bytes = await fetchObjectBytes(doc.bucket, doc.key);
    const text = await extractText(bytes, doc.mimeType || 'application/octet-stream');
    if (!text.trim()) return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
    return { ok: true, text };
  } catch (e) {
    if (e instanceof UnsupportedDocumentTypeError) return { ok: false, error: e.message };
    return toActionError(e);
  }
}

/** Extrahiert Text aus einem hochgeladenen Dokument (PDF/DOCX/Text). */
export async function importDocTextAction(formData: FormData): Promise<OkActionResult<{ text: string }>> {
  try {
    const clientId = String(formData.get('clientId') ?? '');
    await guard(clientId);
    const file = formData.get('file');
    if (!(file instanceof File)) return { ok: false, error: 'Keine Datei übergeben.' };
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = await extractText(bytes, file.type || 'application/octet-stream');
    if (!text.trim()) return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
    return { ok: true, text };
  } catch (e) {
    if (e instanceof UnsupportedDocumentTypeError) return { ok: false, error: e.message };
    return toActionError(e);
  }
}
