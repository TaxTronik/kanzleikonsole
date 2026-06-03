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
  searchNorm,
  addBeraterNorm,
  setNormVerworfen,
  removeBeraterNorm,
  kuratiereKatalogNorm,
  archiveAnalysis,
  reformatSourceDoc,
  reanalyzeAnalysis,
  getLlmStatus,
  listPromptTemplates,
  createPromptTemplate,
  deletePromptTemplate,
  type RiskStatus,
  type ResearchPreview,
  type ResolvedNorm,
  type NormHit,
  type LlmStatusDTO,
  type PromptTemplateDTO,
} from '@/server/risk';
import { enqueueRiskAnalyseLlm, getRiskAnalyseJobState } from '@/server/jobs/risk-analyse-queue';
import { jsonDocToText } from './doc-text';

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
    tx.riskAnalysis.findUnique({ where: { id: analysisId }, select: { clientId: true, archivedAt: true } }),
  );
  if (!analysis?.clientId) throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
  if (analysis.archivedAt) throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
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
      select: { analysis: { select: { id: true, clientId: true, archivedAt: true } } },
    }),
  );
  const clientId = marking?.analysis.clientId;
  if (!clientId) throw new ForbiddenError('Markierung nicht gefunden oder ohne Mandantenbezug.');
  if (marking!.analysis.archivedAt) throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
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
  // Formatierter Sachverhalt (Tiptap/ProseMirror-JSON) — optional; wird als
  // sourceDoc gespeichert. text ist die daraus abgeleitete Plaintext-Serialisierung.
  doc: z.unknown().optional(),
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
      sourceDoc: parsed.doc,
    });
    revalidatePath(`/staff/clients/${parsed.clientId}/subsumtion`);
    return { ok: true, analysisId: res.analysisId, markingCount: res.markingCount };
  } catch (e) {
    return toActionError(e);
  }
}

const UpdateAnalysisSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  title: z.string().max(200).nullable(),
});

/** Ändert den Titel/die Bezeichnung einer Subsumtion (auch im Review-Modus). */
export async function updateAnalysisAction(
  input: z.infer<typeof UpdateAnalysisSchema>,
): Promise<OkActionResult<{ title: string | null }>> {
  try {
    const parsed = UpdateAnalysisSchema.parse(input);
    const { ctx, clientId } = await guardAnalysis(parsed.analysisId);
    const title = parsed.title?.trim() || null;
    await withTenantContext(ctx, (tx) =>
      tx.riskAnalysis.update({ where: { id: parsed.analysisId }, data: { title } }),
    );
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${parsed.analysisId}`);
    revalidatePath(`/staff/clients/${clientId}/subsumtion`);
    return { ok: true, title };
  } catch (e) {
    return toActionError(e);
  }
}

const ReformatSchema = z.object({
  clientId: z.string().uuid(),
  analysisId: z.string().uuid(),
  // Formatierter Sachverhalt (Tiptap/ProseMirror-JSON).
  doc: z.unknown(),
});

/** Speichert die Formatierung des Sachverhalts (sourceDoc), OHNE den
 *  analysierten Text zu ändern. Nur-Format-Edits halten die Markierungen
 *  verankert; eine inhaltliche Textänderung wird abgelehnt (Offsets). */
export async function reformatAnalysisAction(
  input: z.infer<typeof ReformatSchema>,
): Promise<OkActionResult> {
  try {
    const parsed = ReformatSchema.parse(input);
    const { ctx, staffId, clientId } = await guardAnalysis(parsed.analysisId);
    // Plaintext über DIESELBE Serialisierung wie beim Anlegen/Review berechnen,
    // damit der Vergleich gegen den gespeicherten sourceText deckungsgleich ist.
    const newText = jsonDocToText(parsed.doc);
    const res = await reformatSourceDoc(ctx, {
      analysisId: parsed.analysisId,
      doc: parsed.doc,
      newText,
      actorId: staffId,
    });
    if (res.changed === 'text') {
      return {
        ok: false,
        error:
          'Der Textinhalt wurde geändert — in diesem Modus sind nur Formatierungen erlaubt. Für inhaltliche Änderungen bitte eine neue Analyse anlegen.',
      };
    }
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${parsed.analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** Archiviert eine Subsumtion revisionssicher (GoBD-Snapshot, schreibgeschützt). */
export async function archiveAnalysisAction(input: {
  clientId: string;
  analysisId: string;
}): Promise<OkActionResult<{ archiveKey: string }>> {
  try {
    // guardAnalysis wirft, wenn bereits archiviert → kein Re-Archivieren.
    const { ctx, clientId } = await guardAnalysis(input.analysisId);
    const res = await archiveAnalysis(ctx, input.analysisId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${input.analysisId}`);
    revalidatePath(`/staff/clients/${clientId}/subsumtion`);
    return { ok: true, archiveKey: res.key };
  } catch (e) {
    return toActionError(e);
  }
}

/** Liest den LLM-Status (Schicht 2) für die Anzeige im Workspace (verfügbar/lädt
 *  + Queue) UND — falls analysisId gesetzt — ob die LLM-Phase fertig ist
 *  (`enrichedAt`). Der Engine-Status ist best-effort (Fehler ⇒ null), damit die
 *  Fertig-Erkennung (reiner DB-Read) auch bei wackliger Engine funktioniert. */
// BullMQ-Zustände, die einen laufenden/wartenden LLM-Job bedeuten (= „läuft").
const LLM_JOB_RUNNING_STATES = new Set(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized']);

export async function llmStatusAction(input: {
  clientId: string;
  analysisId?: string;
}): Promise<OkActionResult<{ status: LlmStatusDTO | null; enrichedAt: string | null; jobRunning: boolean; jobFailed: boolean; jobError: string | null }>> {
  try {
    const { ctx } = await guard(input.clientId);
    let status: LlmStatusDTO | null = null;
    try { status = await getLlmStatus(); } catch { status = null; }
    let enrichedAt: string | null = null;
    let jobRunning = false;
    let jobFailed = false;
    let jobError: string | null = null;
    if (input.analysisId) {
      const a = await withTenantContext(ctx, (tx) =>
        tx.riskAnalysis.findFirst({
          where: { id: input.analysisId, clientId: input.clientId },
          select: { llmEnrichedAt: true },
        }),
      );
      enrichedAt = a?.llmEnrichedAt ? a.llmEnrichedAt.toISOString() : null;
      // BullMQ-Jobzustand abfragen: `jobRunning` lässt die UI „läuft …" zeigen +
      // den Trigger sperren — auch nach einem Page-Reload (Client-State ist dann
      // weg, der Job-Zustand aber serverseitig bekannt). `failed` beendet „lädt"
      // und bietet Retry an. Best-effort (Queue down ⇒ kein Signal).
      if (a) {
        try {
          const jobState = await getRiskAnalyseJobState(input.analysisId);
          if (jobState?.state === 'failed') {
            jobFailed = true;
            jobError = jobState.failedReason;
          } else if (jobState && LLM_JOB_RUNNING_STATES.has(jobState.state)) {
            jobRunning = true;
          }
        } catch { /* Queue nicht erreichbar → kein Signal, normaler Poll-Lauf */ }
      }
    }
    return { ok: true, status, enrichedAt, jobRunning, jobFailed, jobError };
  } catch (e) {
    return toActionError(e);
  }
}

/** Lässt die Engine erneut (deterministisch) laufen und ergänzt NUR neue
 *  Markierungen (zusammenführend, nicht-destruktiv — Bewertungen bleiben); stößt
 *  anschließend die KI-Phase (mitLLM) async im Worker an. */
export async function reanalyzeAction(input: {
  clientId: string;
  analysisId: string;
}): Promise<OkActionResult<{ added: number; total: number }>> {
  try {
    const { ctx, clientId } = await guardAnalysis(input.analysisId);
    requireEngine();
    const res = await reanalyzeAnalysis(ctx, input.analysisId);
    // KI-Phase ebenfalls anstoßen (async). sourceText aus der gespeicherten
    // Analyse (NICHT vom Client) — Offsets müssen passen.
    const analysis = await withTenantContext(ctx, (tx) =>
      tx.riskAnalysis.findUnique({ where: { id: input.analysisId }, select: { sourceText: true } }),
    );
    if (analysis) {
      await enqueueRiskAnalyseLlm({
        tenantId: ctx.tenantId,
        analysisId: input.analysisId,
        sourceText: analysis.sourceText,
      });
    }
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${input.analysisId}`);
    return { ok: true, added: res.added, total: res.total };
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
  // matchedText wird serverseitig aus dem Sachverhalt abgeleitet (Audit-Treue) —
  // NICHT vom Client übernommen.
  begriff: z.string().min(1).max(200),
  // Strikt Hex (#rrggbb) — die UI sendet feste Swatches; verhindert, dass ein
  // beliebiger String gespeichert wird (Daten-Integrität + Defense gegen ein
  // späteres CSS-Interpolieren der Farbe).
  farbe: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Ungültige Farbe.').nullable().optional(),
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
  // Strikt Hex (#rrggbb) — die UI sendet feste Swatches; verhindert, dass ein
  // beliebiger String gespeichert wird (Daten-Integrität + Defense gegen ein
  // späteres CSS-Interpolieren der Farbe).
  farbe: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Ungültige Farbe.').nullable().optional(),
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

// --- Prompt-Vorlagen (kanzleiweit) ------------------------------------------

/** Listet die kanzleiweiten Prompt-Vorlagen (für den Composer-Auswahl). */
export async function listPromptTemplatesAction(input: {
  clientId: string;
}): Promise<OkActionResult<{ templates: PromptTemplateDTO[] }>> {
  try {
    const { ctx } = await guard(input.clientId);
    const templates = await listPromptTemplates(ctx);
    return { ok: true, templates };
  } catch (e) {
    return toActionError(e);
  }
}

const CreatePromptTemplateSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(1, 'Bitte einen Titel angeben.').max(120),
  body: z.string().min(1, 'Bitte einen Prompt-Text angeben.').max(8000),
});

/** Legt eine neue kanzleiweite Prompt-Vorlage an. */
export async function createPromptTemplateAction(
  input: z.infer<typeof CreatePromptTemplateSchema>,
): Promise<OkActionResult<{ template: PromptTemplateDTO }>> {
  try {
    const parsed = CreatePromptTemplateSchema.parse(input);
    const { ctx } = await guard(parsed.clientId);
    const template = await createPromptTemplate(ctx, { title: parsed.title.trim(), body: parsed.body.trim() });
    return { ok: true, template };
  } catch (e) {
    return toActionError(e);
  }
}

/** Löscht eine Prompt-Vorlage. */
export async function deletePromptTemplateAction(input: {
  clientId: string;
  id: string;
}): Promise<OkActionResult> {
  try {
    const { ctx } = await guard(input.clientId);
    await deletePromptTemplate(ctx, input.id);
    return { ok: true };
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

// --- Rechtsnorm-Kuratierung (Engine-Norm ist nicht verbindlich) ---------------

const SearchNormSchema = z.object({
  clientId: z.string().uuid(),
  query: z.string().trim().min(2).max(200),
});

/** Sucht im Normgraph nach einer Norm (für „eigene Norm" mit stabiler ID/Titel). */
export async function searchNormAction(
  input: z.infer<typeof SearchNormSchema>,
): Promise<OkActionResult<{ hits: NormHit[] }>> {
  try {
    const parsed = SearchNormSchema.parse(input);
    await guard(parsed.clientId);
    requireEngine();
    const hits = await searchNorm(parsed.query);
    return { ok: true, hits };
  } catch (e) {
    return toActionError(e);
  }
}

const AddNormSchema = z.object({
  markingId: z.string().uuid(),
  zitat: z.string().trim().min(1).max(200),
  normId: z.string().trim().min(1).max(200).nullish(),
  titel: z.string().trim().max(400).nullish(),
});

/** Ergänzt eine berater-eigene Rechtsnorm an einer Markierung. */
export async function addBeraterNormAction(
  input: z.infer<typeof AddNormSchema>,
): Promise<OkActionResult> {
  try {
    const parsed = AddNormSchema.parse(input);
    const { ctx, clientId, analysisId } = await guardMarking(parsed.markingId);
    await addBeraterNorm(ctx, parsed.markingId, { zitat: parsed.zitat, id: parsed.normId ?? null, titel: parsed.titel ?? null });
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const VerwerfNormSchema = z.object({
  markingId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  zitat: z.string().max(200),
  verworfen: z.boolean(),
});

/** Verwirft einen Engine-Norm-Vorschlag (oder holt ihn zurück) — soft, auditiert. */
export async function setNormVerworfenAction(
  input: z.infer<typeof VerwerfNormSchema>,
): Promise<OkActionResult> {
  try {
    const parsed = VerwerfNormSchema.parse(input);
    const { ctx, clientId, analysisId } = await guardMarking(parsed.markingId);
    await setNormVerworfen(ctx, parsed.markingId, { index: parsed.index, zitat: parsed.zitat }, parsed.verworfen);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const RemoveNormSchema = z.object({
  markingId: z.string().uuid(),
  index: z.number().int().nonnegative(),
  zitat: z.string().max(200),
});

/** Entfernt eine berater-eigene Norm (Engine-Vorschläge werden nur verworfen). */
export async function removeBeraterNormAction(
  input: z.infer<typeof RemoveNormSchema>,
): Promise<OkActionResult> {
  try {
    const parsed = RemoveNormSchema.parse(input);
    const { ctx, clientId, analysisId } = await guardMarking(parsed.markingId);
    await removeBeraterNorm(ctx, parsed.markingId, { index: parsed.index, zitat: parsed.zitat });
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const KuratiereKatalogNormSchema = z.object({
  markingId: z.string().uuid(),
  norm: z.string().trim().min(1).max(200),
  aktion: z.enum(['verwerfen', 'ergaenzen', 'zuruecksetzen']),
  scope: z.enum(['personal', 'geteilt']),
});

/** Promotion (geschichtet): kuratiert eine Norm der Begriffs-Karte KATALOGWEIT —
 *  wirkt auf künftige Analysen. Engine-Call + Audit in TaxTronik (guardMarking-
 *  staffId = autor; nur Karten mit echtem begriffId). */
export async function kuratiereKatalogNormAction(
  input: z.infer<typeof KuratiereKatalogNormSchema>,
): Promise<OkActionResult> {
  try {
    const parsed = KuratiereKatalogNormSchema.parse(input);
    const { ctx, staffId } = await guardMarking(parsed.markingId);
    requireEngine();
    await kuratiereKatalogNorm(ctx, {
      markingId: parsed.markingId,
      norm: parsed.norm,
      aktion: parsed.aktion,
      scope: parsed.scope,
      autor: staffId,
    });
    return { ok: true };
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
): Promise<OkActionResult<{ text: string; suggestedTitle: string | null }>> {
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
      return { mimeType: d.mimeType, bucket: v.storageBucket, key: v.storageKey, title: d.title };
    });
    if (!doc) return { ok: false, error: 'Dokument nicht gefunden.' };

    // App-proxied: Bytes intern aus SeaweedFS holen (Store nie öffentlich).
    const bytes = await fetchObjectBytes(doc.bucket, doc.key);
    const text = await extractText(bytes, doc.mimeType || 'application/octet-stream');
    if (!text.trim()) return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
    return { ok: true, text, suggestedTitle: doc.title?.trim() || null };
  } catch (e) {
    if (e instanceof UnsupportedDocumentTypeError) return { ok: false, error: e.message };
    return toActionError(e);
  }
}

/** Extrahiert Text aus einem hochgeladenen Dokument (PDF/DOCX/Text). */
export async function importDocTextAction(
  formData: FormData,
): Promise<OkActionResult<{ text: string; suggestedTitle: string | null }>> {
  try {
    const clientId = String(formData.get('clientId') ?? '');
    await guard(clientId);
    const file = formData.get('file');
    if (!(file instanceof File)) return { ok: false, error: 'Keine Datei übergeben.' };
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = await extractText(bytes, file.type || 'application/octet-stream');
    if (!text.trim()) return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
    // Dateiname ohne Endung als Titel-Vorschlag (Pfadanteile/Extension entfernt).
    const base = (file.name || '').replace(/\.[^.]+$/, '').replace(/[\\/]/g, ' ').trim();
    return { ok: true, text, suggestedTitle: base || null };
  } catch (e) {
    if (e instanceof UnsupportedDocumentTypeError) return { ok: false, error: e.message };
    return toActionError(e);
  }
}
