'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { toActionError } from '@/server/auth/rbac';
import {
  pushDefinitionToCatalog,
  resolveNorm,
  searchNorm,
  addBeraterNorm,
  setNormVerworfen,
  removeBeraterNorm,
  kuratiereKatalogNorm,
  readKatalogKuratierung,
  setKatalogReviewStatus,
  type ResolvedNorm,
  type NormHit,
} from '@/server/risk';
import {
  guard,
  guardWrite,
  guardMarkingWrite,
  requireEngine,
  type OkActionResult,
} from './_guards';
// Aufgeteilt aus actions.ts (1272 Zeilen) — Guards in ./_guards.ts.

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

const ResolveByZitatSchema = z.object({
  clientId: z.string().uuid(),
  zitat: z.string().trim().min(1).max(200),
});

/** Löst ein freies Norm-Zitat (z. B. einer eigenen Markierung ohne Engine-ID) über
 *  den Normgraph auf → Gesetzestext, damit auch frei eingetippte Normen aufklappbar
 *  sind. Bevorzugt den exakten Zitat-Treffer, sonst den besten. `norm:null` = nichts
 *  gefunden. `matchedZitat` zeigt an, falls die Engine auf eine gröbere Norm fiel. */
export async function resolveNormByZitatAction(
  input: z.infer<typeof ResolveByZitatSchema>,
): Promise<OkActionResult<{ norm: ResolvedNorm | null; matchedZitat: string | null }>> {
  try {
    const parsed = ResolveByZitatSchema.parse(input);
    await guard(parsed.clientId);
    requireEngine();
    const hits = await searchNorm(parsed.zitat);
    const lc = (s: string) => s.trim().toLowerCase();
    const hit = hits.find((h) => lc(h.zitat) === lc(parsed.zitat)) ?? hits[0] ?? null;
    if (!hit) return { ok: true, norm: null, matchedZitat: null };
    const norm = await resolveNorm(hit.id);
    return { ok: true, norm, matchedZitat: hit.zitat };
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
    const { ctx, clientId, analysisId } = await guardMarkingWrite(parsed.markingId);
    await addBeraterNorm(ctx, parsed.markingId, {
      zitat: parsed.zitat,
      id: parsed.normId ?? null,
      titel: parsed.titel ?? null,
    });
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
    const { ctx, clientId, analysisId } = await guardMarkingWrite(parsed.markingId);
    await setNormVerworfen(
      ctx,
      parsed.markingId,
      { index: parsed.index, zitat: parsed.zitat },
      parsed.verworfen,
    );
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
    const { ctx, clientId, analysisId } = await guardMarkingWrite(parsed.markingId);
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
    const { ctx, staffId } = await guardMarkingWrite(parsed.markingId);
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

const KatalogKuratierungSchema = z.object({
  clientId: z.string().uuid(),
  katalogId: z.string().min(1).max(200),
});

/** Liest den katalogweiten Kuratierungszustand eines Begriffs (zum Überlagern der
 *  Norm-Anzeige) — verworfene Norm-IDs + ergänzte Normen, scope-gefiltert für den
 *  anfragenden Berater. */
export async function katalogKuratierungAction(
  input: z.infer<typeof KatalogKuratierungSchema>,
): Promise<
  OkActionResult<{ verworfen: string[]; ergaenzt: { zitat: string; id: string | null }[] }>
> {
  try {
    const parsed = KatalogKuratierungSchema.parse(input);
    const { staffId } = await guard(parsed.clientId);
    requireEngine();
    const view = await readKatalogKuratierung(parsed.katalogId, staffId);
    return { ok: true, verworfen: view.verworfen, ergaenzt: view.ergaenzt };
  } catch (e) {
    return toActionError(e);
  }
}

const ReviewKatalogBegriffSchema = z.object({
  clientId: z.string().uuid(),
  katalogId: z.string().min(1).max(200),
  // 'entwurf' ist der Startzustand und von hier nicht setzbar — die Engine
  // erlaubt ohnehin nur Vorwärts-Übergänge.
  status: z.enum(['geprüft', 'freigegeben']),
});

/** Freigabe-Lebenszyklus des geteilten Festwissens (§4, Engine 1.1.0): schaltet
 *  einen geteilten Berater-Eintrag vorwärts (entwurf → geprüft → freigegeben).
 *  Der Übergang läuft IMMER über `POST /v1/katalog/review` — erst die Engine-
 *  Bestätigung (vollständiger Übergang) landet in der Audit-Chain. */
export async function reviewKatalogBegriffAction(
  input: z.infer<typeof ReviewKatalogBegriffSchema>,
): Promise<OkActionResult<{ alterStatus: string; neuerStatus: string }>> {
  try {
    const parsed = ReviewKatalogBegriffSchema.parse(input);
    const { ctx } = await guardWrite(parsed.clientId);
    requireEngine();
    const res = await setKatalogReviewStatus(ctx, {
      begriffId: parsed.katalogId,
      status: parsed.status,
    });
    return { ok: true, alterStatus: res.alterStatus, neuerStatus: res.neuerStatus };
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
    const { ctx, clientId, analysisId } = await guardMarkingWrite(parsed.markingId);
    requireEngine();
    const res = await pushDefinitionToCatalog(ctx, parsed);
    revalidatePath(`/staff/clients/${clientId}/subsumtion/${analysisId}`);
    return { ok: true, begriffId: res.begriffId };
  } catch (e) {
    return toActionError(e);
  }
}
