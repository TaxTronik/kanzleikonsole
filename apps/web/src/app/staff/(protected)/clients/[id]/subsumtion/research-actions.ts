'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { ActionError, toActionError } from '@/server/auth/rbac';
import {
  previewResearch,
  sendResearchToN8n,
  assignResultToMarking,
  listPromptTemplates,
  createPromptTemplate,
  deletePromptTemplate,
  saveResearchResultToShelf,
  setResearchResultArchived,
  setResearchResultVerworfen,
  deleteResearchResult,
  type ResearchPreview,
  type PromptTemplateDTO,
} from '@/server/risk';
import {
  guard,
  guardWrite,
  guardResultWrite,
  guardResearch,
  type OkActionResult,
  guardResultReview,
} from './_guards';
// Aufgeteilt aus actions.ts (1272 Zeilen) — Guards in ./_guards.ts.

// --- Rechercheauftrag an n8n (anonymisiert) ---------------------------------

const ResearchSchema = z
  .object({
    clientId: z.string().uuid(),
    analysisId: z.string().uuid(),
    // Titel der Recherche — leer = auto "Recherche vom [Datum], [Uhrzeit]".
    title: z.string().max(200).nullable().optional(),
    // markingId optional: gesetzt = Recherche zu einer Markierung; null = allgemeine Frage.
    markingId: z.string().uuid().nullable().optional(),
    // Eigener Recherche-Sachverhalt / Auszug / ganzer Sachverhalt.
    sachverhalt: z.enum(['custom', 'excerpt', 'full']),
    snippets: z.array(z.string().max(4000)).max(20).optional(),
    prompt: z.string().max(8000).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.sachverhalt === 'custom' &&
      !(input.snippets ?? []).some((snippet) => snippet.trim().length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['snippets'],
        message: 'Bitte einen Sachverhalt für diese Recherche eingeben.',
      });
    }
  });

/** Baut + anonymisiert den Auftrag und gibt die Vorschau zurück (kein Senden). */
export async function previewResearchAction(
  input: z.infer<typeof ResearchSchema>,
): Promise<OkActionResult<ResearchPreview>> {
  try {
    const parsed = ResearchSchema.parse(input);
    const { ctx, scope } = await guardResearch(parsed);
    const preview = await previewResearch(ctx, parsed, scope);
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
    const { ctx } = await guardWrite(parsed.clientId);
    const template = await createPromptTemplate(ctx, {
      title: parsed.title.trim(),
      body: parsed.body.trim(),
    });
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
    const { ctx } = await guardWrite(input.clientId);
    await deletePromptTemplate(ctx, input.id);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

const SendResearchSchema = ResearchSchema.safeExtend({
  finalText: z.string().min(1).max(40_000),
  finalPrompt: z.string().max(8000).nullable(),
});

/** Sendet den (geprüften) anonymisierten Auftrag an n8n. */
export async function sendResearchAction(
  input: z.infer<typeof SendResearchSchema>,
): Promise<OkActionResult<{ requestId: string; eventId: string; deliveryStatus: 'PENDING' }>> {
  try {
    const parsed = SendResearchSchema.parse(input);
    const { ctx, clientId, scope } = await guardResearch(parsed);
    const res = await sendResearchToN8n(ctx, parsed, scope);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${parsed.analysisId}`);
    if (res.delivery.status !== 'PENDING' || !res.delivery.eventId) {
      const message =
        res.delivery.status === 'UNROUTED'
          ? 'Kein aktiver n8n-Workflow ist dem Recherche-Event zugeordnet. Bitte das n8n-Setup prüfen.'
          : res.delivery.status === 'SKIPPED'
            ? `Die n8n-Zustellung ist nicht möglich: ${res.delivery.error ?? 'Integration deaktiviert oder unvollständig konfiguriert.'}`
            : 'Der Rechercheauftrag wurde gespeichert, konnte aber nicht zur n8n-Zustellung eingeplant werden.';
      throw new ActionError(message);
    }
    return {
      ok: true,
      requestId: res.requestId,
      eventId: res.delivery.eventId,
      deliveryStatus: res.delivery.status,
    };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Ergebnis als geprüft-und-unbrauchbar kennzeichnen.
 *
 * Gegenstück zu `assignResultAction`: Beides sind Prüfentscheidungen. Wer an
 * einer Markierung recherchieren darf, darf das Ergebnis auch verwerfen —
 * `markingId` ist deshalb Pflicht und bindet die Entscheidung an genau die
 * Markierung, zu der das Ergebnis gehört.
 */
export async function setResultVerworfenAction(input: {
  clientId: string;
  analysisId: string;
  resultId: string;
  markingId: string;
}): Promise<OkActionResult> {
  try {
    // Komplette Pruefkette (Zugriff, Recherche-Recht, Ergebnis-Bindung,
    // Ziel-Analyse) in EINER Guard-Tx — siehe guardResultReview.
    const { ctx, clientId, analysisId } = await guardResultReview(
      input.resultId,
      input.markingId,
      'verwerfen',
    );
    await setResearchResultVerworfen(ctx, input.resultId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function assignResultAction(input: {
  clientId: string;
  analysisId: string;
  resultId: string;
  markingId: string;
}): Promise<OkActionResult> {
  try {
    // Ergebnis der eigenen zugewiesenen Markierung zuordnen darf auch die
    // recherchierende Person; fremde Markierungen nur die volle Stufe.
    // Pruefkette inkl. Ergebnis-Bindung + Ziel-Analyse in EINER Guard-Tx.
    const { ctx, clientId, analysisId } = await guardResultReview(
      input.resultId,
      input.markingId,
      'uebernehmen',
    );
    await assignResultToMarking(ctx, input.resultId, input.markingId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function archiveResultAction(input: {
  resultId: string;
  archived: boolean;
}): Promise<OkActionResult> {
  try {
    const { ctx, clientId, analysisId } = await guardResultWrite(input.resultId);
    await setResearchResultArchived(ctx, input.resultId, input.archived);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function deleteResultAction(input: { resultId: string }): Promise<OkActionResult> {
  try {
    const { ctx, clientId, analysisId } = await guardResultWrite(input.resultId);
    await deleteResearchResult(ctx, input.resultId);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

/**
 * Legt ein Rechercheergebnis als Markdown-Dokument im Aktenregal des
 * Sachverhalts ab (Ein-Klick-Ablage). Die Bytes sind app-generiert
 * (kein Nutzer-Upload) → skipScan; Schutzstufe NONE, Klassifikation GENERAL.
 */
export async function saveResultToShelfAction(input: {
  resultId: string;
}): Promise<OkActionResult<{ documentId: string | null; alreadySaved: boolean }>> {
  try {
    const { ctx, staffId, clientId, analysisId } = await guardResultWrite(input.resultId);
    const saved = await saveResearchResultToShelf(ctx, {
      resultId: input.resultId,
      clientId,
      analysisId,
      staffId,
    });

    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId ?? ''}`);
    return { ok: true, ...saved };
  } catch (e) {
    return toActionError(e);
  }
}
