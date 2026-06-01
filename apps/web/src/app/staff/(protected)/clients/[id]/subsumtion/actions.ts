'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import {
  requireSubsumtionAccess,
  requireStaffSession,
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
  previewResearch,
  sendResearchToN8n,
  assignResultToMarking,
  resolveNorm,
  type RiskStatus,
  type ResearchPreview,
  type ResolvedNorm,
} from '@/server/risk';
import { enqueueRiskAnalyseLlm } from '@/server/jobs/risk-analyse-queue';

type OkActionResult<T = unknown> = ({ ok: true } & T) | ActionErrorResult;

interface GuardResult {
  ctx: TenantContext;
  staffId: string;
  /** Der tatsächliche Mandant der Ressource (NICHT der Payload-clientId). */
  clientId: string;
}

async function requireRiskModule(ctx: TenantContext): Promise<void> {
  const modules = await readModules(ctx);
  if (!modules.risk) throw new ForbiddenError('Das Subsumtions-Modul ist für diese Kanzlei deaktiviert.');
}

// Gemeinsamer Guard: Zugang (Admin/Partner oder zuständig für DIESEN Mandanten) +
// aktives Modul. Nur für Aktionen, deren Subjekt der clientId selbst ist (z. B.
// „neue Analyse anlegen") — die clientId IST hier das autorisierte Ziel.
async function guard(clientId: string): Promise<{ ctx: TenantContext; staffId: string }> {
  const session = await requireSubsumtionAccess(clientId);
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  await requireRiskModule(ctx);
  return { ctx, staffId };
}

// Session + Tenant-Kontext OHNE per-Mandant-Prüfung — Basis für die Ressourcen-
// Guards (die den Mandanten erst aus der Ressource ableiten).
async function sessionCtx(): Promise<{ ctx: TenantContext; staffId: string }> {
  const session = await requireStaffSession();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  await requireRiskModule(ctx);
  return { ctx, staffId };
}

// Autorisiert über die ECHTE clientId der Analyse — nicht über einen vom Client
// gelieferten clientId. Verhindert IDOR (Zugriff auf fremde Mandanten desselben
// Tenants durch Spoofing der Payload-clientId).
async function guardAnalysis(analysisId: string): Promise<GuardResult> {
  const { ctx, staffId } = await sessionCtx();
  const analysis = await withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findUnique({ where: { id: analysisId }, select: { clientId: true } }),
  );
  if (!analysis?.clientId) throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
  await requireSubsumtionAccess(analysis.clientId);
  return { ctx, staffId, clientId: analysis.clientId };
}

// Wie guardAnalysis, aber ausgehend von einer Markierung (leitet Analyse +
// Mandant ab). Liefert auch die analysisId für revalidatePath.
async function guardMarking(markingId: string): Promise<GuardResult & { analysisId: string }> {
  const { ctx, staffId } = await sessionCtx();
  const marking = await withTenantContext(ctx, (tx) =>
    tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { analysis: { select: { id: true, clientId: true } } },
    }),
  );
  const clientId = marking?.analysis.clientId;
  if (!clientId) throw new ForbiddenError('Markierung nicht gefunden oder ohne Mandantenbezug.');
  await requireSubsumtionAccess(clientId);
  return { ctx, staffId, clientId, analysisId: marking!.analysis.id };
}

// Ausgehend von einem Rechercheergebnis (über Request bzw. Markierung → Analyse).
async function guardResult(resultId: string): Promise<GuardResult & { analysisId: string | null }> {
  const { ctx, staffId } = await sessionCtx();
  const result = await withTenantContext(ctx, (tx) =>
    tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: {
        request: { select: { analysis: { select: { id: true, clientId: true } } } },
        marking: { select: { analysis: { select: { id: true, clientId: true } } } },
      },
    }),
  );
  const analysis = result?.request?.analysis ?? result?.marking?.analysis ?? null;
  if (!analysis?.clientId) throw new ForbiddenError('Ergebnis nicht gefunden oder ohne Mandantenbezug.');
  await requireSubsumtionAccess(analysis.clientId);
  return { ctx, staffId, clientId: analysis.clientId, analysisId: analysis.id };
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
}): Promise<OkActionResult> {
  try {
    const { ctx } = await guardAnalysis(input.analysisId);
    requireEngine();
    // sourceText NICHT vom Client übernehmen — aus der gespeicherten Analyse
    // laden (Offsets der LLM-Markierungen müssen zum gespeicherten Text passen;
    // Determinismus/Audit; keine Manipulation des analysierten Texts).
    const analysis = await withTenantContext(ctx, (tx) =>
      tx.riskAnalysis.findUnique({ where: { id: input.analysisId }, select: { sourceText: true } }),
    );
    if (!analysis) return { ok: false, error: 'Analyse nicht gefunden.' };
    await enqueueRiskAnalyseLlm({
      tenantId: ctx.tenantId,
      analysisId: input.analysisId,
      sourceText: analysis.sourceText,
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
    const { ctx, clientId } = await guardAnalysis(parsed.analysisId);
    const res = await addManualMarking(ctx, parsed);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${parsed.analysisId}`);
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
    // clientId/analysisId aus dem Payload nur Routing — Autorisierung + echte IDs
    // kommen aus guardMarking; sie dürfen NICHT als Markierungsfelder durchsickern.
    const { markingId, clientId: _c, analysisId: _a, ...fields } = UpdateMarkingSchema.parse(input);
    const { ctx, clientId, analysisId } = await guardMarking(markingId);
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
    const { ctx, clientId, analysisId } = await guardMarking(input.markingId);
    await deleteMarking(ctx, input.markingId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
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
    const { ctx, staffId, clientId, analysisId } = await guardMarking(parsed.markingId);
    const res = await delegateMarking(ctx, {
      markingId: parsed.markingId,
      createdByStaffId: staffId,
      assigneeStaffId: parsed.assigneeStaffId,
      dueDate: parsed.dueDate ? new Date(parsed.dueDate) : undefined,
      notes: parsed.notes,
    });
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true, reminderId: res.reminderId };
  } catch (e) {
    return toActionError(e);
  }
}

// --- Rechercheauftrag an n8n (anonymisiert) ---------------------------------

const ResearchSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  // markingId optional: gesetzt = Recherche zu einer Markierung; null = ganzer Fall.
  markingId: z.string().uuid().nullable().optional(),
  // Kein / Auszug (nur mit Markierung sinnvoll) / ganzer Sachverhalt.
  sachverhalt: z.enum(['none', 'excerpt', 'full']),
  snippets: z.array(z.string().max(4000)).max(20).optional(),
  prompt: z.string().max(8000).nullable().optional(),
});

/** Baut + anonymisiert den Auftrag und gibt die Vorschau zurück (kein Senden). */
export async function previewResearchAction(
  input: z.infer<typeof ResearchSchema>,
): Promise<OkActionResult<ResearchPreview>> {
  try {
    const parsed = ResearchSchema.parse(input);
    const { ctx } = await guardAnalysis(parsed.analysisId);
    const preview = await previewResearch(ctx, parsed);
    return { ok: true, ...preview };
  } catch (e) {
    return toActionError(e);
  }
}

const SendResearchSchema = ResearchSchema.extend({ finalText: z.string().min(1).max(40_000) });

/** Sendet den (geprüften) anonymisierten Auftrag an n8n. */
export async function sendResearchAction(
  input: z.infer<typeof SendResearchSchema>,
): Promise<OkActionResult<{ requestId: string }>> {
  try {
    const parsed = SendResearchSchema.parse(input);
    const { ctx, clientId } = await guardAnalysis(parsed.analysisId);
    const res = await sendResearchToN8n(ctx, parsed);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${parsed.analysisId}`);
    return { ok: true, requestId: res.requestId };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignResultAction(input: {
  clientId: string;
  analysisId: string;
  resultId: string;
  markingId: string | null;
}): Promise<OkActionResult> {
  try {
    const { ctx, clientId, analysisId } = await guardResult(input.resultId);
    // Ziel-Markierung (falls gesetzt) muss zur SELBEN Analyse gehören — sonst
    // ließe sich ein Ergebnis quer auf eine fremde Markierung verlinken.
    if (input.markingId) {
      const target = await withTenantContext(ctx, (tx) =>
        tx.riskMarking.findUnique({ where: { id: input.markingId! }, select: { analysisId: true } }),
      );
      if (!target || target.analysisId !== analysisId) {
        return { ok: false, error: 'Markierung gehört nicht zu dieser Analyse.' };
      }
    }
    await assignResultToMarking(ctx, input.resultId, input.markingId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const ResolveNormSchema = z.object({
  clientId: z.string().uuid(),
  // Engine-Norm-ID, z. B. "norm:KStG:8" oder granular "norm:UStG:2:abs2:nr2".
  normId: z.string().min(1).max(200),
});

/** Lädt den Gesetzestext zu einer Norm-ID (für das Norm-Expandable im Panel). */
export async function resolveNormAction(
  input: z.infer<typeof ResolveNormSchema>,
): Promise<OkActionResult<{ norm: ResolvedNorm }>> {
  try {
    const parsed = ResolveNormSchema.parse(input);
    await guard(parsed.clientId);
    requireEngine();
    const norm = await resolveNorm(parsed.normId);
    return { ok: true, norm };
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
    const { ctx, clientId, analysisId } = await guardMarking(parsed.markingId);
    requireEngine();
    const res = await pushDefinitionToCatalog(ctx, parsed);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
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
