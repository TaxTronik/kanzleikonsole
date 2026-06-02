// =============================================================================
// Rechercheauftrag → n8n (anonymisiert) + Ergebnis-Zuordnung.
//
// previewResearch: baut den berater-gesteuerten Auftrag, anonymisiert ihn und
//   gibt die Vorschau zurück — OHNE zu persistieren/senden.
// sendResearchToN8n: re-anonymisiert den (ggf. editierten) Text noch einmal als
//   Sicherheitsnetz, persistiert RiskResearchRequest (mit Mapping für die
//   spätere De-Anonymisierung) und reiht das n8n-Event ein.
// receiveResearchResult: Inbound von n8n — Korrelation → automatische Zuordnung
//   + De-Anonymisierung; sonst NEU in der Ablage.
// suggestMarkingsForResult / assignResultToMarking: intelligente Zuordnung.
// =============================================================================

import { withTenantContext, withSystemContext, type TenantContext, type TxClient } from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';
import { enqueueN8nEvent } from '@/server/n8n/outbox';
import { evidenceService } from '@/server/container';
import { anonymize, deanonymize } from './anonymize';
import { reflowProse } from './reflow';

export type SachverhaltMode = 'none' | 'excerpt' | 'full';

export interface ResearchInput {
  analysisId: string;
  /** Per-Markierung (Rechtsfrage + Auszug) ODER null = ganzer Fall. */
  markingId?: string | null;
  sachverhalt: SachverhaltMode;
  snippets?: string[];
  prompt?: string | null;
}

export interface ResearchPreview {
  rechtsfrage: string;
  normAnker: string[];
  governanceTyp: string | null;
  anonymizedText: string;
  heuristicHits: string[];
}

function excerpt(text: string, start: number, end: number, pad = 500): string {
  const a = Math.max(0, start - pad);
  const b = Math.min(text.length, end + pad);
  return (a > 0 ? '… ' : '') + text.slice(a, b).trim() + (b < text.length ? ' …' : '');
}

/** Lädt Analyse (+ optional Markierung) + Mandant/Kontakte und baut den ROHEN
 *  (sensiblen) Auftragstext. Unterstützt per-Markierung und ganzen Fall. */
async function buildRaw(tx: TxClient, tenantId: string, input: ResearchInput) {
  const analysis = await tx.riskAnalysis.findFirst({
    where: { id: input.analysisId, tenantId },
    select: { id: true, clientId: true, sourceText: true, katalogVersion: true },
  });
  if (!analysis) throw new Error('Analyse nicht gefunden.');
  const clientId = analysis.clientId;
  if (!clientId) throw new Error('Recherche erfordert einen Mandantenbezug der Analyse.');

  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId },
    select: { name: true, datevNo: true, addisonNo: true, vatId: true, street: true, postalCode: true, city: true },
  });
  if (!client) throw new Error('Mandant nicht gefunden.');
  const contacts = await tx.clientContact.findMany({
    where: { clientId, active: true },
    select: { fullName: true, email: true, phone: true },
  });

  let marking: { id: string; begriff: string; normAnker: string[]; governanceTyp: string | null; start: number; end: number } | null = null;
  if (input.markingId) {
    marking = await tx.riskMarking.findFirst({
      where: { id: input.markingId, analysisId: analysis.id },
      select: { id: true, begriff: true, normAnker: true, governanceTyp: true, start: true, end: true },
    });
    if (!marking) throw new Error('Markierung nicht gefunden.');
  }

  const parts: string[] = [];
  if (marking) {
    parts.push(`Rechtsfrage: ${marking.begriff}`);
    if (marking.normAnker.length > 0) parts.push(`Normanker: ${marking.normAnker.join(', ')}`);
    if (marking.governanceTyp) parts.push(`Governance-Typ: ${marking.governanceTyp}`);
  }
  if (input.sachverhalt === 'full') {
    parts.push('Sachverhalt:\n' + reflowProse(analysis.sourceText));
  } else if (input.sachverhalt === 'excerpt' && marking) {
    parts.push('Sachverhalt-Auszug:\n' + reflowProse(excerpt(analysis.sourceText, marking.start, marking.end)));
  }
  for (const s of input.snippets ?? []) if (s.trim()) parts.push(s.trim());
  if (input.prompt && input.prompt.trim()) parts.push('Auftrag: ' + input.prompt.trim());

  return {
    analysis,
    marking,
    client,
    contacts,
    rawText: parts.join('\n\n'),
    rechtsfrage: marking ? marking.begriff : 'Recherche zum Sachverhalt',
    normAnker: marking?.normAnker ?? [],
    governanceTyp: marking?.governanceTyp ?? null,
  };
}

/** Baut + anonymisiert den Auftrag, OHNE zu persistieren/senden (Vorschau). */
export async function previewResearch(ctx: TenantContext, input: ResearchInput): Promise<ResearchPreview> {
  return withTenantContext(ctx, async (tx) => {
    const { client, contacts, rawText, rechtsfrage, normAnker, governanceTyp } = await buildRaw(
      tx,
      ctx.tenantId,
      input,
    );
    const anon = anonymize(rawText, { client, contacts });
    return { rechtsfrage, normAnker, governanceTyp, anonymizedText: anon.text, heuristicHits: anon.heuristicHits };
  });
}

/**
 * Persistiert den Auftrag (anonymisiert) + Mapping und reiht das n8n-Event ein.
 * `finalText` ist der vom Berater geprüfte/editierte anonymisierte Text — er wird
 * VOR dem Senden nochmals durch die Anonymisierung geschickt (Sicherheitsnetz
 * gegen versehentlich wieder eingefügte Klartextdaten).
 */
export async function sendResearchToN8n(
  ctx: TenantContext,
  input: ResearchInput & { finalText: string },
): Promise<{ requestId: string; sentText: string }> {
  const prepared = await withTenantContext(ctx, async (tx) => {
    const { analysis, marking, client, contacts, rawText, rechtsfrage, normAnker, governanceTyp } =
      await buildRaw(tx, ctx.tenantId, input);

    // Mapping aus dem ROH-Text (deckt die ursprünglichen Platzhalter für die
    // De-Anonymisierung der Antwort) + Sicherheits-Pass über den finalen Text
    // (fängt vom Berater wieder eingefügte bekannte Entitäten).
    const baseMapping = anonymize(rawText, { client, contacts }).mapping;
    const safe = anonymize(input.finalText, { client, contacts });
    // rechtsfrage geht als eigenes Feld raus → ebenfalls anonymisieren. Bei BERATER-
    // Markierungen ist begriff Freitext und kann Mandantenbezug enthalten (§203).
    const safeRechtsfrage = anonymize(rechtsfrage, { client, contacts });
    // Reihenfolge = Priorität (späteres gewinnt). `safe` (der gesendete
    // anonymizedText) MUSS gewinnen: die n8n-Antwort echo't dessen Platzhalter,
    // also muss deren De-Anonymisierung aus safe.mapping kommen. Heuristik-
    // Platzhalter ([BETRAG_1]…) sind pro Text nummeriert und könnten sonst auf
    // das Original der rechtsfrage statt des gesendeten Texts zurückfallen.
    const mapping = { ...baseMapping, ...safeRechtsfrage.mapping, ...safe.mapping };

    const payload = {
      rechtsfrage: safeRechtsfrage.text,
      normAnker,
      governanceTyp,
      anonymizedText: safe.text,
      katalogVersion: analysis.katalogVersion,
    };

    const req = await tx.riskResearchRequest.create({
      data: {
        tenantId: ctx.tenantId,
        analysisId: analysis.id,
        markingId: marking?.id ?? null,
        prompt: input.prompt?.trim() || null,
        includeSachverhalt: input.sachverhalt !== 'none',
        anonymizedPayload: payload as object,
        mapping: mapping as object,
        createdById: ctx.actorId ?? analysis.id, // actorId ist für STAFF gesetzt
      },
      select: { id: true },
    });

    // Audit: WAS gesendet wurde (Metadaten) — NICHT der anonymisierte Volltext
    // und NIE das mapping (Datenminimierung; das mapping ist bereits RLS-geschützt
    // am Request gespeichert).
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.research.sent',
      resourceType: 'risk_research_request',
      resourceId: req.id,
      after: {
        analysisId: analysis.id,
        markingId: marking?.id ?? null,
        sachverhalt: input.sachverhalt,
        normAnker,
        governanceTyp,
      },
    });

    return { requestId: req.id, payload, sentText: safe.text };
  });

  // Event NACH dem Commit einreihen. researchRequestId = opaker Korrelations-
  // Token; der Payload enthält KEINE Klartext-Mandantendaten.
  await enqueueN8nEvent(
    'risk.research_requested',
    { researchRequestId: prepared.requestId, ...prepared.payload },
    { tenantId: ctx.tenantId },
  );

  return { requestId: prepared.requestId, sentText: prepared.sentText };
}

// --- Inbound (von n8n) -------------------------------------------------------

export interface InboundResult {
  researchRequestId?: string | null;
  tenantId?: string | null;
  title?: string | null;
  body: string;
  source?: string | null;
}

/**
 * Nimmt ein n8n-Ergebnis entgegen. Läuft ohne User-Session (Inbound-Endpoint) →
 * prismaOwner. Korrelation über researchRequestId: automatische Zuordnung +
 * De-Anonymisierung. Ohne Korrelation: NEU in der Ablage (Tenant aus Payload).
 */
export async function receiveResearchResult(input: InboundResult): Promise<{ resultId: string } | null> {
  let tenantId = input.tenantId ?? null;
  let markingId: string | null = null;
  let body = input.body;

  // Cross-Tenant-Lookup (wir kennen den Tenant noch nicht) → owner/BYPASSRLS.
  if (input.researchRequestId) {
    const req = await prismaOwner.riskResearchRequest.findUnique({
      where: { id: input.researchRequestId },
      select: { tenantId: true, markingId: true, mapping: true },
    });
    if (req) {
      tenantId = req.tenantId;
      markingId = req.markingId;
      body = deanonymize(input.body, (req.mapping as Record<string, string>) ?? {});
    }
  }

  if (!tenantId) return null; // ohne Tenant nicht zuordenbar

  // Schreiben unter SYSTEM-Kontext → RLS-WITH-CHECK greift (Defense in Depth).
  const result = await withSystemContext(tenantId, async (tx) => {
    if (input.researchRequestId) {
      await tx.riskResearchRequest.updateMany({
        where: { id: input.researchRequestId, tenantId },
        data: { status: 'ANSWERED' },
      });
    }
    const created = await tx.riskResearchResult.create({
      data: {
        tenantId,
        researchRequestId: input.researchRequestId ?? null,
        markingId,
        title: input.title ?? null,
        body,
        source: input.source ?? 'n8n',
        status: markingId ? 'ZUGEORDNET' : 'NEU',
      },
      select: { id: true },
    });
    // Inbound von n8n — kein User. SYSTEM-Akteur in unserer Chain.
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'risk.research.received',
      resourceType: 'risk_research_result',
      resourceId: created.id,
      after: {
        researchRequestId: input.researchRequestId ?? null,
        markingId,
        source: input.source ?? 'n8n',
        autoAssigned: markingId != null,
      },
    });
    return created;
  });
  return { resultId: result.id };
}

// --- Intelligente Zuordnung (für die Ablage-UI) ------------------------------

/** §-Zitate aus einem Text extrahieren (für die Normanker-Heuristik). */
function extractNormRefs(text: string): string[] {
  const out = new Set<string>();
  const re = /§+\s?\d+[a-z]?(?:\s?Abs\.?\s?\d+)?(?:\s?(?:S\.|Satz)\s?\d+)?\s?[A-ZÄÖÜ][A-Za-zÄÖÜ]{1,6}/g;
  for (const m of text.matchAll(re)) out.add(m[0].replace(/\s+/g, ' ').trim());
  return [...out];
}

export interface MarkingSuggestion {
  markingId: string;
  begriff: string;
  score: number;
  reason: string;
}

/**
 * Schlägt offene/fragliche Markierungen für ein (noch nicht zugeordnetes)
 * Ergebnis vor. Stärkstes Signal: gemeinsame Normanker (§-Zitate); zusätzlich
 * Begriff-Überlappung.
 */
export async function suggestMarkingsForResult(
  ctx: TenantContext,
  resultId: string,
): Promise<MarkingSuggestion[]> {
  return withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: { body: true, title: true, request: { select: { analysisId: true } } },
    });
    if (!result) return [];
    const text = `${result.title ?? ''}\n${result.body}`.toLowerCase();
    const refs = extractNormRefs(`${result.title ?? ''}\n${result.body}`).map((r) => r.toLowerCase());

    const markings = await tx.riskMarking.findMany({
      where: {
        status: { in: ['OFFEN', 'IN_PRUEFUNG'] },
        ...(result.request?.analysisId ? { analysisId: result.request.analysisId } : {}),
      },
      select: { id: true, begriff: true, normAnker: true, engineStatus: true },
      take: 200,
    });

    const scored: MarkingSuggestion[] = [];
    for (const m of markings) {
      const ankerLower = m.normAnker.map((a) => a.toLowerCase());
      const normOverlap = ankerLower.filter((a) => refs.some((r) => r.includes(a) || a.includes(r))).length;
      const begriffHit = m.begriff && text.includes(m.begriff.toLowerCase()) ? 1 : 0;
      const score = normOverlap * 3 + begriffHit * 2;
      if (score > 0) {
        const reasons: string[] = [];
        if (normOverlap > 0) reasons.push(`${normOverlap} gemeinsame Normanker`);
        if (begriffHit) reasons.push('Begriff erwähnt');
        scored.push({ markingId: m.id, begriff: m.begriff, score, reason: reasons.join(' · ') });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3);
  });
}

/** Ordnet ein Ergebnis manuell einer Markierung zu. */
export async function assignResultToMarking(
  ctx: TenantContext,
  resultId: string,
  markingId: string | null,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.riskResearchResult.update({
      where: { id: resultId },
      data: { markingId, status: markingId ? 'ZUGEORDNET' : 'VERWORFEN' },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: markingId ? 'risk.research.assigned' : 'risk.research.discarded',
      resourceType: 'risk_research_result',
      resourceId: resultId,
      after: { markingId: markingId ?? null },
    });
  });
}
