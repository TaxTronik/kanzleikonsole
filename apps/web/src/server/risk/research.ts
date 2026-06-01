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
import { anonymize, deanonymize } from './anonymize';

export interface ResearchInput {
  markingId: string;
  includeSachverhalt: boolean;
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

/** Lädt Marking + Mandant/Kontakte und baut den ROHEN (sensiblen) Auftragstext. */
async function buildRaw(tx: TxClient, tenantId: string, input: ResearchInput) {
  const marking = await tx.riskMarking.findUnique({
    where: { id: input.markingId },
    include: {
      analysis: { select: { id: true, clientId: true, sourceText: true, katalogVersion: true } },
    },
  });
  if (!marking) throw new Error('Markierung nicht gefunden.');
  const clientId = marking.analysis.clientId;
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

  const parts: string[] = [`Rechtsfrage: ${marking.begriff}`];
  if (marking.normAnker.length > 0) parts.push(`Normanker: ${marking.normAnker.join(', ')}`);
  if (marking.governanceTyp) parts.push(`Governance-Typ: ${marking.governanceTyp}`);
  if (input.includeSachverhalt) {
    parts.push('Sachverhalt-Auszug:\n' + excerpt(marking.analysis.sourceText, marking.start, marking.end));
  }
  for (const s of input.snippets ?? []) if (s.trim()) parts.push(s.trim());
  if (input.prompt && input.prompt.trim()) parts.push('Auftrag: ' + input.prompt.trim());

  return { marking, client, contacts, rawText: parts.join('\n\n') };
}

/** Baut + anonymisiert den Auftrag, OHNE zu persistieren/senden (Vorschau). */
export async function previewResearch(ctx: TenantContext, input: ResearchInput): Promise<ResearchPreview> {
  return withTenantContext(ctx, async (tx) => {
    const { marking, client, contacts, rawText } = await buildRaw(tx, ctx.tenantId, input);
    const anon = anonymize(rawText, { client, contacts });
    return {
      rechtsfrage: marking.begriff,
      normAnker: marking.normAnker,
      governanceTyp: marking.governanceTyp,
      anonymizedText: anon.text,
      heuristicHits: anon.heuristicHits,
    };
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
    const { marking, client, contacts, rawText } = await buildRaw(tx, ctx.tenantId, input);

    // Mapping aus dem ROH-Text (deckt die ursprünglichen Platzhalter für die
    // De-Anonymisierung der Antwort) + Sicherheits-Pass über den finalen Text
    // (fängt vom Berater wieder eingefügte bekannte Entitäten).
    const baseMapping = anonymize(rawText, { client, contacts }).mapping;
    const safe = anonymize(input.finalText, { client, contacts });
    const mapping = { ...baseMapping, ...safe.mapping };

    const payload = {
      rechtsfrage: marking.begriff,
      normAnker: marking.normAnker,
      governanceTyp: marking.governanceTyp,
      anonymizedText: safe.text,
      katalogVersion: marking.analysis.katalogVersion,
    };

    const req = await tx.riskResearchRequest.create({
      data: {
        tenantId: ctx.tenantId,
        analysisId: marking.analysis.id,
        markingId: marking.id,
        prompt: input.prompt?.trim() || null,
        includeSachverhalt: input.includeSachverhalt,
        anonymizedPayload: payload as object,
        mapping: mapping as object,
        createdById: ctx.actorId ?? marking.analysis.id, // actorId ist für STAFF gesetzt
      },
      select: { id: true },
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
    return tx.riskResearchResult.create({
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
  await withTenantContext(ctx, (tx) =>
    tx.riskResearchResult.update({
      where: { id: resultId },
      data: { markingId, status: markingId ? 'ZUGEORDNET' : 'VERWORFEN' },
    }),
  );
}
