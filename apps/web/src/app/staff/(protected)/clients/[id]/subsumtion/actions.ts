'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { requireSubsumtionAccess, ForbiddenError, toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { getClientIp } from '@/server/rate-limit';
import {
  runDeterministicAnalysis,
  updateMarking,
  addManualMarking,
  deleteMarking,
  delegateMarking,
  extractText,
  UnsupportedDocumentTypeError,
  archiveAnalysis,
  reformatSourceDoc,
  reanalyzeAnalysis,
  getLlmStatus,
  type RiskStatus,
  type LlmStatusDTO,
} from '@/server/risk';
import { enqueueRiskAnalyseLlm, getRiskAnalyseJobState } from '@/server/jobs/risk-analyse-queue';
import { jsonDocToText } from './doc-text';
import {
  guard,
  sessionCtx,
  assertMay,
  guardWrite,
  guardAnalysisWrite,
  guardMarkingWrite,
  requireEngine,
  type OkActionResult,
} from './_guards';
// Aufgeteilt aus actions.ts (1272 Zeilen) — Guards in ./_guards.ts.

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
    const { ctx, staffId } = await guardWrite(parsed.clientId);
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
    const { ctx, clientId } = await guardAnalysisWrite(parsed.analysisId);
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
    const { ctx, staffId, clientId } = await guardAnalysisWrite(parsed.analysisId);
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
    const { ctx, clientId } = await guardAnalysisWrite(input.analysisId);
    const res = await archiveAnalysis(ctx, input.analysisId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${input.analysisId}`);
    revalidatePath(`/staff/clients/${clientId}/subsumtion`);
    return { ok: true, archiveKey: res.key };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Kennzeichnet eine Subsumtion als vertraulich — oder hebt das auf.
 *
 * Folge: Wer keine Schreibrechte am Mandanten hat und nur eine einzelne
 * Markierung zur Recherche zugewiesen bekam, sieht ab dann ausschliesslich
 * diese Textstelle statt des ganzen Sachverhalts (siehe `redactSachverhalt`).
 *
 * Bewusst NICHT ueber `guardAnalysisWrite`: das lehnt archivierte Analysen ab.
 * Vertraulichkeit ist aber eine Zugriffs-, keine Inhaltsentscheidung — sie
 * muss auch nachtraeglich noch setzbar sein, ohne den Snapshot zu beruehren.
 */
export async function setAnalysisVertraulichAction(input: {
  analysisId: string;
  vertraulich: boolean;
}): Promise<OkActionResult> {
  try {
    const { ctx, staffId } = await sessionCtx();
    const analysis = await withTenantContext(ctx, (tx) =>
      tx.riskAnalysis.findUnique({
        where: { id: input.analysisId },
        select: { clientId: true, vertraulich: true },
      }),
    );
    if (!analysis?.clientId)
      throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
    await requireSubsumtionAccess(analysis.clientId);
    await assertMay(ctx, analysis.clientId, input.analysisId, 'schreiben');

    if (analysis.vertraulich !== input.vertraulich) {
      await withTenantContext(ctx, async (tx) => {
        await tx.riskAnalysis.update({
          where: { id: input.analysisId },
          data: { vertraulich: input.vertraulich },
        });
        await evidenceService.record(tx, {
          tenantId: ctx.tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: input.vertraulich
            ? 'subsumtion.vertraulich.gesetzt'
            : 'subsumtion.vertraulich.aufgehoben',
          resourceType: 'risk_analysis',
          resourceId: input.analysisId,
          before: { vertraulich: analysis.vertraulich },
          after: { vertraulich: input.vertraulich, clientId: analysis.clientId },
        });
      });
    }

    revalidatePath(`/staff/clients/${analysis.clientId}/subsumtion/${input.analysisId}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/** Liest den LLM-Status (Schicht 2) für die Anzeige im Workspace (verfügbar/lädt
 *  + Queue) UND — falls analysisId gesetzt — ob die LLM-Phase fertig ist
 *  (`enrichedAt`). Der Engine-Status ist best-effort (Fehler ⇒ null), damit die
 *  Fertig-Erkennung (reiner DB-Read) auch bei wackliger Engine funktioniert. */
// BullMQ-Zustände, die einen laufenden/wartenden LLM-Job bedeuten (= „läuft").
const LLM_JOB_RUNNING_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'waiting-children',
  'prioritized',
]);

export async function llmStatusAction(input: { clientId: string; analysisId?: string }): Promise<
  OkActionResult<{
    status: LlmStatusDTO | null;
    enrichedAt: string | null;
    jobRunning: boolean;
    jobFailed: boolean;
    jobError: string | null;
  }>
> {
  try {
    const { ctx } = await guard(input.clientId);
    let status: LlmStatusDTO | null = null;
    try {
      status = await getLlmStatus();
    } catch {
      status = null;
    }
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
        } catch {
          /* Queue nicht erreichbar → kein Signal, normaler Poll-Lauf */
        }
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
    const { ctx, clientId } = await guardAnalysisWrite(input.analysisId);
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
    const { ctx } = await guardAnalysisWrite(input.analysisId);
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
  farbe: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Ungültige Farbe.')
    .nullable()
    .optional(),
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
    const { ctx, clientId } = await guardAnalysisWrite(parsed.analysisId);
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
  wahrscheinlichkeit: z
    .enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG'])
    .nullable()
    .optional(),
  kaskadenreichweite: z.number().int().min(0).max(99).nullable().optional(),
  kontrolle: z.string().max(2000).nullable().optional(),
  status: z.enum(['OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT']).optional(),
  notiz: z.string().max(4000).nullable().optional(),
  verantwortlichId: z.string().uuid().nullable().optional(),
  // Strikt Hex (#rrggbb) — die UI sendet feste Swatches; verhindert, dass ein
  // beliebiger String gespeichert wird (Daten-Integrität + Defense gegen ein
  // späteres CSS-Interpolieren der Farbe).
  farbe: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Ungültige Farbe.')
    .nullable()
    .optional(),
  label: z.string().max(100).nullable().optional(),
});

export async function updateMarkingAction(
  input: z.infer<typeof UpdateMarkingSchema>,
): Promise<OkActionResult> {
  try {
    // clientId/analysisId aus dem Payload nur Routing — Autorisierung + echte IDs
    // kommen aus guardMarking; sie dürfen NICHT als Markierungsfelder durchsickern.
    const { markingId, clientId: _c, analysisId: _a, ...fields } = UpdateMarkingSchema.parse(input);
    const { ctx, clientId, analysisId } = await guardMarkingWrite(markingId);
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
    const { ctx, clientId, analysisId } = await guardMarkingWrite(input.markingId);
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
    const { ctx, staffId, clientId, analysisId } = await guardMarkingWrite(parsed.markingId);
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

const ImportDocSchema = z.object({ clientId: z.string().uuid(), documentId: z.string().uuid() });

/** Holt ein vorhandenes Mandanten-Dokument aus dem Object-Store (SeaweedFS) und
 *  extrahiert den Text. Der Zugriff wird wie ein Download auditiert. */
export async function importClientDocAction(
  input: z.infer<typeof ImportDocSchema>,
): Promise<OkActionResult<{ text: string; suggestedTitle: string | null }>> {
  try {
    const parsed = ImportDocSchema.parse(input);
    const { ctx, staffId } = await guardWrite(parsed.clientId);
    const h = await headers();
    const ip = getClientIp(h);
    const userAgent = h.get('user-agent');

    const doc = await withTenantContext(ctx, async (tx) => {
      // Defense in Depth: expliziter Tenant-/Client-Filter zusätzlich zu RLS.
      const d = await tx.document.findFirst({
        where: {
          id: parsed.documentId,
          clientId: parsed.clientId,
          tenantId: ctx.tenantId,
          deletedAt: null,
        },
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
    if (!text.trim())
      return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
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
    await guardWrite(clientId);
    const file = formData.get('file');
    if (!(file instanceof File)) return { ok: false, error: 'Keine Datei übergeben.' };
    const bytes = Buffer.from(await file.arrayBuffer());
    const text = await extractText(bytes, file.type || 'application/octet-stream');
    if (!text.trim())
      return { ok: false, error: 'Das Dokument enthält keinen extrahierbaren Text.' };
    // Dateiname ohne Endung als Titel-Vorschlag (Pfadanteile/Extension entfernt).
    const base = (file.name || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/]/g, ' ')
      .trim();
    return { ok: true, text, suggestedTitle: base || null };
  } catch (e) {
    if (e instanceof UnsupportedDocumentTypeError) return { ok: false, error: e.message };
    return toActionError(e);
  }
}
