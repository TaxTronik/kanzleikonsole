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

import {
  withTenantContext,
  withSystemContext,
  type TenantContext,
  type TxClient,
} from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';
import { enqueueN8nEvent, type N8nEnqueueResult } from '@/server/n8n/outbox';
import {
  claimN8nCallbackReceipt,
  setN8nCallbackReceiptResult,
  type N8nCallbackReceiptKey,
} from '@/server/n8n/callback-receipts';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { anonymize, deanonymize } from './anonymize';
import { reflowProse } from './reflow';
import { scoreMarkingSuggestions, type MarkingSuggestion } from './suggest';

export type SachverhaltMode = 'custom' | 'excerpt' | 'full';

export interface ResearchInput {
  analysisId: string;
  /** Per-Markierung (Rechtsfrage + Auszug) ODER null = allgemeine Recherchefrage. */
  markingId?: string | null;
  /** Titel der Recherche — leer/null = auto "Recherche vom [Datum], [Uhrzeit]". */
  title?: string | null;
  sachverhalt: SachverhaltMode;
  snippets?: string[];
  prompt?: string | null;
}

/** Auto-Titel, wenn der Berater keinen vergibt — macht mehrere Einzelrecherchen
 *  zum selben Sachverhalt unterscheidbar. */
export function defaultResearchTitle(now = new Date()): string {
  const datum = now.toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const uhrzeit = now.toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Recherche vom ${datum}, ${uhrzeit} Uhr`;
}

export interface ResearchPreview {
  rechtsfrage: string;
  normAnker: string[];
  governanceTyp: string | null;
  anonymizedText: string;
  anonymizedPrompt: string | null;
  heuristicHits: string[];
}

function excerpt(text: string, start: number, end: number, pad: number | undefined = 500): string {
  const a = Math.max(0, start - pad);
  const b = Math.min(text.length, end + pad);
  return (a > 0 ? '… ' : '') + text.slice(a, b).trim() + (b < text.length ? ' …' : '');
}

/**
 * Rechtelage der auftraggebenden Person — vom Guard gesetzt, NIE aus dem
 * Client-Payload. Steuert, wie viel Sachverhalt in den Auftrag darf.
 */
export interface ResearchScope {
  /** Volle Bearbeitungsrechte am Mandanten (Admin/Partner/Berufsträger). */
  volleAkteneinsicht: boolean;
}

const OFFEN: ResearchScope = { volleAkteneinsicht: true };

/** Lädt Analyse (+ optional Markierung) + Mandant/Kontakte und baut den ROHEN
 *  (sensiblen) Auftragstext. Unterstützt per-Markierung und ganzen Fall. */
async function buildRaw(
  tx: TxClient,
  tenantId: string,
  input: ResearchInput,
  scope: ResearchScope,
) {
  const analysis = await tx.riskAnalysis.findFirst({
    where: { id: input.analysisId, tenantId },
    select: {
      id: true,
      clientId: true,
      sourceText: true,
      katalogVersion: true,
      vertraulich: true,
    },
  });
  if (!analysis) throw new Error('Analyse nicht gefunden.');
  const clientId = analysis.clientId;
  if (!clientId) throw new Error('Recherche erfordert einen Mandantenbezug der Analyse.');

  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      name: true,
      datevNo: true,
      addisonNo: true,
      vatId: true,
      street: true,
      postalCode: true,
      city: true,
    },
  });
  if (!client) throw new Error('Mandant nicht gefunden.');
  const contacts = await tx.clientContact.findMany({
    where: { clientId, active: true },
    select: { fullName: true, email: true, phone: true },
  });

  let marking: {
    id: string;
    begriff: string;
    normAnker: string[];
    governanceTyp: string | null;
    start: number;
    end: number;
  } | null = null;
  if (input.markingId) {
    marking = await tx.riskMarking.findFirst({
      where: { id: input.markingId, analysisId: analysis.id },
      select: {
        id: true,
        begriff: true,
        normAnker: true,
        governanceTyp: true,
        start: true,
        end: true,
      },
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
    // Kein doppeltes Label, wenn der erfasste Sachverhalt selbst schon mit
    // "Sachverhalt:" beginnt ("Sachverhalt:\nSachverhalt: ..." im Payload).
    const prose = reflowProse(analysis.sourceText);
    parts.push(/^\s*sachverhalt\s*:/i.test(prose) ? prose : 'Sachverhalt:\n' + prose);
  } else if (input.sachverhalt === 'excerpt' && marking) {
    // Bei einer vertraulichen Analyse darf eine nur zugewiesene Person den
    // Sachverhalt nicht sehen — dann darf der Auszug auch keinen Kontext
    // mitschicken, sondern ausschliesslich die markierte Stelle selbst. Ohne
    // das ginge über den Umweg „Auszug an die KI" genau der Text nach draussen,
    // den die Ansicht gerade zurückhält.
    const pad = analysis.vertraulich && !scope.volleAkteneinsicht ? 0 : undefined;
    parts.push(
      'Sachverhalt-Auszug:\n' +
        reflowProse(excerpt(analysis.sourceText, marking.start, marking.end, pad)),
    );
  }
  const snippets = (input.snippets ?? []).map((snippet) => snippet.trim()).filter(Boolean);
  if (input.sachverhalt === 'custom' && snippets.length > 0) {
    parts.push('Sachverhalt für diese Recherche:\n' + snippets.join('\n\n'));
  }
  return {
    analysis,
    marking,
    client,
    contacts,
    rawText: parts.join('\n\n'),
    rechtsfrage: marking ? marking.begriff : 'Allgemeine Recherchefrage',
    normAnker: marking?.normAnker ?? [],
    governanceTyp: marking?.governanceTyp ?? null,
  };
}

/** Baut + anonymisiert den Auftrag, OHNE zu persistieren/senden (Vorschau). */
export async function previewResearch(
  ctx: TenantContext,
  input: ResearchInput,
  scope: ResearchScope = OFFEN,
): Promise<ResearchPreview> {
  return withTenantContext(ctx, async (tx) => {
    const { client, contacts, rawText, rechtsfrage, normAnker, governanceTyp } = await buildRaw(
      tx,
      ctx.tenantId,
      input,
      scope,
    );
    const anon = anonymize(rawText, { client, contacts });
    const prompt = input.prompt?.trim() || null;
    const anonPrompt = prompt ? anonymize(prompt, { client, contacts }) : null;
    return {
      rechtsfrage,
      normAnker,
      governanceTyp,
      anonymizedText: anon.text,
      anonymizedPrompt: anonPrompt?.text ?? null,
      heuristicHits: [...new Set([...anon.heuristicHits, ...(anonPrompt?.heuristicHits ?? [])])],
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
  input: ResearchInput & { finalText: string; finalPrompt: string | null },
  scope: ResearchScope = OFFEN,
): Promise<{ requestId: string; sentText: string; delivery: N8nEnqueueResult }> {
  const prepared = await withTenantContext(ctx, async (tx) => {
    const { analysis, marking, client, contacts, rawText, rechtsfrage, normAnker, governanceTyp } =
      await buildRaw(tx, ctx.tenantId, input, scope);

    // Mapping aus dem ROH-Text (deckt die ursprünglichen Platzhalter für die
    // De-Anonymisierung der Antwort) + Sicherheits-Pass über den finalen Text
    // (fängt vom Berater wieder eingefügte bekannte Entitäten).
    const baseMapping = anonymize(rawText, { client, contacts }).mapping;
    const safe = anonymize(input.finalText, { client, contacts });
    // rechtsfrage geht als eigenes Feld raus → ebenfalls anonymisieren. Bei BERATER-
    // Markierungen ist begriff Freitext und kann Mandantenbezug enthalten (§203).
    const safeRechtsfrage = anonymize(rechtsfrage, { client, contacts });
    // Der Auftrag (Recherche-Frage) geht zusätzlich als EIGENES Feld raus,
    // damit n8n-Workflows die Frage nicht per String-Parsing aus dem
    // kombinierten anonymizedText extrahieren müssen. Freitext des Beraters →
    // ebenfalls anonymisieren.
    const promptText = input.finalPrompt?.trim() || null;
    const safeAuftrag = promptText ? anonymize(promptText, { client, contacts }) : null;
    // Reihenfolge = Priorität (späteres gewinnt). `safe` (der gesendete
    // anonymizedText) MUSS gewinnen: die n8n-Antwort echo't dessen Platzhalter,
    // also muss deren De-Anonymisierung aus safe.mapping kommen. Heuristik-
    // Platzhalter ([BETRAG_1]…) sind pro Text nummeriert und könnten sonst auf
    // das Original der rechtsfrage statt des gesendeten Texts zurückfallen.
    const mapping = {
      ...baseMapping,
      ...safeRechtsfrage.mapping,
      ...(safeAuftrag?.mapping ?? {}),
      ...safe.mapping,
    };

    const payload = {
      rechtsfrage: safeRechtsfrage.text,
      normAnker,
      governanceTyp,
      /** Recherche-Frage des Beraters, separat und anonymisiert (null, wenn keine erfasst). */
      auftrag: safeAuftrag?.text ?? null,
      anonymizedText: safe.text,
      katalogVersion: analysis.katalogVersion,
    };

    const req = await tx.riskResearchRequest.create({
      data: {
        tenantId: ctx.tenantId,
        analysisId: analysis.id,
        markingId: marking?.id ?? null,
        title: input.title?.trim() || defaultResearchTitle(),
        prompt: input.prompt?.trim() || null,
        includeSachverhalt: input.sachverhalt !== 'custom',
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
  const delivery = await enqueueN8nEvent(
    'risk.research_requested',
    { researchRequestId: prepared.requestId, ...prepared.payload },
    { tenantId: ctx.tenantId },
  );

  // Der explizite Benutzerbefehl darf UNROUTED/SKIPPED nicht als erfolgreich
  // darstellen. Der Auftrag bleibt als nachvollziehbare Historie erhalten,
  // bekommt aber einen ehrlichen FAILED-Status; die Action zeigt die konkrete
  // Setup-Ursache an. PENDING ist bereits durable und wird ggf. reconciled.
  if (delivery.status !== 'PENDING') {
    await withTenantContext(ctx, (tx) =>
      tx.riskResearchRequest.update({
        where: { id: prepared.requestId },
        data: { status: 'FAILED' },
      }),
    );
  }

  return { requestId: prepared.requestId, sentText: prepared.sentText, delivery };
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
export async function receiveResearchResult(
  input: InboundResult,
  callbackReceipt?: N8nCallbackReceiptKey,
): Promise<{ resultId: string; duplicate: boolean } | null> {
  let tenantId = input.tenantId ?? null;
  let markingId: string | null = null;
  let body = input.body;
  let title = input.title ?? null;
  // Notify-on-arrival: Empfänger + Sprungziel (nur im Korrelationsfall bekannt).
  let recipientStaffId: string | null = null;
  let hrefClientId: string | null = null;
  let hrefAnalysisId: string | null = null;

  // Cross-Tenant-Lookup (wir kennen den Tenant noch nicht) → owner/BYPASSRLS.
  if (input.researchRequestId) {
    const req = await prismaOwner.riskResearchRequest.findUnique({
      where: { id: input.researchRequestId },
      select: {
        tenantId: true,
        markingId: true,
        title: true,
        mapping: true,
        createdById: true,
        analysisId: true,
        analysis: { select: { clientId: true } },
      },
    });
    if (req) {
      tenantId = req.tenantId;
      markingId = req.markingId;
      body = deanonymize(input.body, (req.mapping as Record<string, string>) ?? {});
      recipientStaffId = req.createdById;
      hrefAnalysisId = req.analysisId;
      hrefClientId = req.analysis?.clientId ?? null;
      // Liefert der Workflow keinen eigenen Titel, erbt das Ergebnis den
      // Recherche-Titel — so bleiben mehrere Einzelrecherchen unterscheidbar.
      if (!title && req.title) title = req.title;
    }
  }

  if (!tenantId) return null; // ohne Tenant nicht zuordenbar

  // Schreiben unter SYSTEM-Kontext → RLS-WITH-CHECK greift (Defense in Depth).
  const result = await withSystemContext(tenantId, async (tx) => {
    if (callbackReceipt) {
      const receipt = await claimN8nCallbackReceipt(tx, {
        ...callbackReceipt,
        tenantId,
      });
      if (receipt.duplicate) {
        if (!receipt.resultId) {
          throw new Error('completed research callback receipt has no result id');
        }
        return { id: receipt.resultId, duplicate: true };
      }
    }

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
        title,
        body,
        source: input.source ?? 'n8n',
        status: markingId ? 'ZUGEORDNET' : 'NEU',
      },
      select: { id: true },
    });
    if (callbackReceipt) {
      await setN8nCallbackReceiptResult(tx, { ...callbackReceipt, tenantId }, created.id);
    }
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

    // Notify-on-arrival: Auftraggeber:in (oder alle, wenn unbekannt). Reuse
    // REQUEST_RESPONDED — der Titel macht den Recherche-Kontext klar.
    await notify(tx, {
      tenantId,
      staffId: recipientStaffId,
      kind: 'REQUEST_RESPONDED',
      title: `Rechercheergebnis eingegangen${title ? ': ' + title : ''}`,
      body: input.source ? `Quelle: ${input.source}` : null,
      href:
        hrefClientId && hrefAnalysisId
          ? `/staff/clients/${hrefClientId}/subsumtion/${hrefAnalysisId}?view=recherche`
          : null,
      resourceType: 'risk_research_result',
      resourceId: created.id,
    });
    return { id: created.id, duplicate: false };
  });
  return { resultId: result.id, duplicate: result.duplicate };
}

// --- Intelligente Zuordnung (für die Ablage-UI) ------------------------------

/**
 * Schlägt offene/fragliche Markierungen für ein (noch nicht zugeordnetes)
 * Ergebnis vor. Lädt Ergebnis + offene Markierungen der Ursprungs-Analyse und
 * scort in-memory (reine Logik in ./suggest). Hinweis: die Subsumtions-SEITE
 * scort direkt mit ihren bereits geladenen Markierungen (kein N+1) — diese
 * DB-Variante bleibt für Einzel-Aufrufe ohne vorhandene Markierungen.
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
    const markings = await tx.riskMarking.findMany({
      where: {
        status: { in: ['OFFEN', 'IN_PRUEFUNG'] },
        ...(result.request?.analysisId ? { analysisId: result.request.analysisId } : {}),
      },
      select: { id: true, begriff: true, normAnker: true, status: true },
      take: 200,
    });
    return scoreMarkingSuggestions(result, markings);
  });
}

/** Ordnet ein Ergebnis manuell einer Markierung zu. */
export async function assignResultToMarking(
  ctx: TenantContext,
  resultId: string,
  markingId: string,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await tx.riskResearchResult.update({
      where: { id: resultId },
      data: { markingId, status: 'ZUGEORDNET' },
    });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.research.assigned',
      resourceType: 'risk_research_result',
      resourceId: resultId,
      after: { markingId },
    });
  });
}
