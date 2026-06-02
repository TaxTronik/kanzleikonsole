// =============================================================================
// Persistenz eines Risk-Analyse-Laufs (tenant-scoped, RLS).
//
// Speichert RiskAnalysis + alle Markierungen in EINER Transaktion. `rawResult`
// hält den vollständigen Engine-Output (Audit/Replay); die TCMS-relevanten
// Felder liegen erstklassig pro Markierung. Die Engine selbst persistiert nichts
// (§4) — das ist hier die datenführende Seite.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { RiskAnalysisResult } from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { storeRawResult } from './raw-store';

export interface SaveAnalysisInput {
  result: RiskAnalysisResult;
  /** Der analysierte Sachverhalt im Klartext (für Wieder-Öffnen + LLM-Phase). */
  sourceText: string;
  /** Formatierter Sachverhalt (Tiptap-JSON); sourceText ist dessen Serialisierung. */
  sourceDoc?: unknown;
  /** Optionale Bezeichnung der Subsumtion. */
  title?: string | null;
  /** Optionaler Mandantenbezug (Pflicht erst für die Delegation). */
  clientId?: string | null;
  /** Optionaler Dokumentbezug (SeaweedFS-Dokument). */
  documentId?: string | null;
  /** StaffUser, der die Analyse ausgelöst hat. */
  createdById: string;
}

export interface SaveAnalysisResult {
  analysisId: string;
  markingCount: number;
}

export async function saveAnalysis(
  ctx: TenantContext,
  input: SaveAnalysisInput,
): Promise<SaveAnalysisResult> {
  // Evidenz-Hash SELBST berechnen (nicht der Engine vertrauen): sha256 über den
  // exakt gespeicherten Sachverhalt. Damit ist der Audit-Anker rekonstruierbar
  // und unabhängig von der (zustandslosen) Engine — die gesamte Audit-Logik
  // bleibt in TaxTronik. Der Engine-text_hash dient nur als Quervergleich.
  const contentHash = createHash('sha256').update(input.sourceText, 'utf8').digest('hex');
  const engineHash = input.result.textHash;
  if (engineHash && engineHash !== contentHash) {
    log.warn(
      { component: 'risk', contentHash, engineHash },
      'risk: Engine-text_hash weicht vom selbst berechneten sha256(sourceText) ab',
    );
  }

  // ID vorab erzeugen → rawResult VOR der Transaktion in SeaweedFS ablegen (gzip),
  // damit die DB-Transaktion nicht während des Object-Store-Calls offen bleibt.
  // Scheitert der Upload, brechen wir ab, bevor die DB berührt wird.
  const analysisId = randomUUID();
  const raw = await storeRawResult(ctx.tenantId, analysisId, input.result.rawResult);

  return withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.create({
      data: {
        id: analysisId,
        tenantId: ctx.tenantId,
        clientId: input.clientId ?? null,
        documentId: input.documentId ?? null,
        sourceText: input.sourceText,
        // Rich-Doc optional (Tiptap-JSON); undefined → SQL NULL.
        sourceDoc: input.sourceDoc != null ? (input.sourceDoc as object) : undefined,
        title: input.title ?? null,
        // Unser eigener Hash ist der maßgebliche (rekonstruierbar aus sourceText).
        textHash: contentHash,
        katalogVersion: input.result.katalogVersion,
        engineVersion: input.result.engineVersion,
        createdById: input.createdById,
        // rawResult liegt im Object-Store — nur die Referenz hier.
        rawResultBucket: raw.bucket,
        rawResultKey: raw.key,
        markings: {
          create: input.result.markings.map((m) => ({
            tenantId: ctx.tenantId,
            start: m.start,
            end: m.end,
            matchedText: m.matchedText,
            herkunft: m.herkunft,
            begriffId: m.begriffId,
            begriff: m.begriff,
            normAnker: m.normAnker,
            // normRefs optional: leer → SQL NULL (UI fällt auf normAnker-Zitate zurück).
            normRefs: m.normRefs.length > 0 ? (m.normRefs as object) : undefined,
            // normketten optional: undefined → SQL NULL (kein Json-null nötig).
            normketten: m.normketten === null ? undefined : (m.normketten as object),
            governanceTyp: m.governanceTyp,
            schadensintensitaet: m.schadensintensitaet,
            wahrscheinlichkeit: m.wahrscheinlichkeit,
            kaskadenreichweite: m.kaskadenreichweite,
            engineStatus: m.engineStatus,
            streitig: m.streitig,
          })),
        },
      },
      select: { id: true, _count: { select: { markings: true } } },
    });

    // Hash + Lauf in die TaxTronik-Hash-Chain (audit_log) ankern — manipulations-
    // evident + täglich RFC-3161-versiegelt. Im selben Tx wie die Analyse (atomar).
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: input.createdById,
      action: 'risk.analysis.created',
      resourceType: 'risk_analysis',
      resourceId: analysis.id,
      after: {
        contentHash,
        engineTextHash: engineHash,
        hashMatch: !engineHash || engineHash === contentHash,
        katalogVersion: input.result.katalogVersion,
        engineVersion: input.result.engineVersion,
        markingCount: analysis._count.markings,
        clientId: input.clientId ?? null,
        documentId: input.documentId ?? null,
        title: input.title ?? null,
      },
    });

    return { analysisId: analysis.id, markingCount: analysis._count.markings };
  });
}
