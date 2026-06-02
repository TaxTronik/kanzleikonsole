// =============================================================================
// Risk-Analyse LLM-Phase (async, on-demand).
//
// Phase 2 des Subsumtions-Workspace: der schnelle deterministische Lauf hat die
// Analyse + Markierungen bereits angelegt (Web-Server-Action). Dieser Job ruft
// die Engine erneut mit `mitLLM:true` (15–30 s) und hängt die ZUSÄTZLICHEN
// Markierungen (Herkunft EMBEDDING/LLM) an die bestehende Analyse an — ohne die
// schon vorhandenen zu duplizieren. Setzt danach `llmEnrichedAt`.
//
// Eigenständig im Worker (kein @taxtronik/web-Import): Engine-Client kommt aus
// dem Paket, persistiert wird über den Worker-Owner-Client + tenant-context.
// =============================================================================

import { Worker } from 'bullmq';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection, type RiskAnalyseLlmJob } from '../queues';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';

const markingKey = (m: { start: number; end: number; herkunft: string; begriff: string }) =>
  `${m.start}:${m.end}:${m.herkunft}:${m.begriff}`;

// record() braucht nur den Tx (der TimestampPort dient dem Versiegeln, nicht dem
// Schreiben). Audit bleibt in TaxTronik — die Engine führt keins.
const evidence = new EvidenceService(new LocalTimestampAdapter());

export const riskAnalyseLlmWorker = new Worker<RiskAnalyseLlmJob, void, string>(
  'risk-analyse-llm',
  async (job) => {
    const { tenantId, analysisId, sourceText, optionen } = job.data;

    const client = new RiskLayerClient();
    const result = await client.analyse({ text: sourceText, mitLLM: true, optionen });

    await withWorkerTenantContext(tenantId, async (tx) => {
      const analysis = await tx.riskAnalysis.findUnique({
        where: { id: analysisId },
        select: { id: true, markings: { select: { start: true, end: true, herkunft: true, begriff: true } } },
      });
      if (!analysis) {
        // Analyse wurde zwischenzeitlich gelöscht — nicht erneut versuchen.
        log.warn({ analysisId, tenantId }, 'risk-analyse-llm: Analyse nicht mehr vorhanden, übersprungen');
        return;
      }

      const existing = new Set(analysis.markings.map(markingKey));
      const fresh = result.markings.filter((m) => !existing.has(markingKey(m)));

      if (fresh.length > 0) {
        await tx.riskMarking.createMany({
          data: fresh.map((m) => ({
            tenantId,
            analysisId,
            start: m.start,
            end: m.end,
            matchedText: m.matchedText,
            herkunft: m.herkunft,
            begriffId: m.begriffId,
            begriff: m.begriff,
            normAnker: m.normAnker,
            normRefs: m.normRefs.length > 0 ? (m.normRefs as object) : undefined,
            normketten: m.normketten === null ? undefined : (m.normketten as object),
            governanceTyp: m.governanceTyp,
            schadensintensitaet: m.schadensintensitaet,
            wahrscheinlichkeit: m.wahrscheinlichkeit,
            kaskadenreichweite: m.kaskadenreichweite,
            engineStatus: m.engineStatus,
            streitig: m.streitig,
          })),
        });
      }

      await tx.riskAnalysis.update({
        where: { id: analysisId },
        data: { llmEnrichedAt: new Date() },
      });

      await evidence.record(tx, {
        tenantId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'risk.analysis.llm_enriched',
        resourceType: 'risk_analysis',
        resourceId: analysisId,
        after: { added: fresh.length, total: result.markings.length, engineVersion: result.engineVersion },
      });

      log.info(
        { analysisId, tenantId, added: fresh.length, total: result.markings.length },
        'risk-analyse-llm: Analyse angereichert',
      );
    });
  },
  { connection, concurrency: 1 },
);
