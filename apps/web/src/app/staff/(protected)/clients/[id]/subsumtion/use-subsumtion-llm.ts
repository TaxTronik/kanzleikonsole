'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { llmStatusAction } from './actions';
import type { LlmStatusDTO } from '@/server/risk/llm';

export function useSubsumtionLlm({
  clientId,
  analysisId,
  engineConfigured,
  enriched,
  onRefresh,
  onInfo,
}: {
  clientId: string;
  analysisId: string;
  engineConfigured: boolean;
  enriched: string | null;
  onRefresh: () => void;
  onInfo: (message: string) => void;
}) {
  // LLM-Status (Schicht 2): einmal beim Mount holen; nach „LLM dazuschalten"
  // engmaschig pollen. Ist der Lauf fertig (llmEnrichedAt gesetzt), WEICH
  // aktualisieren (router.refresh — der Editor/Cursor/Scroll bleibt erhalten) und
  // die neuen KI-Markierungen hervorheben. Kein harter Reload.
  const [llmState, setLlm] = useState<LlmStatusDTO | null>(null);
  const llm = engineConfigured ? llmState : null;
  const [pollLlm, setPollLlm] = useState(false);
  const [llmJobState, setLlmJobState] = useState<string | null>(null);
  const [llmWorkerAvailable, setLlmWorkerAvailable] = useState<boolean | null>(null);
  // Final fehlgeschlagener KI-Lauf (Worker-Job). Beendet das „lädt" und bietet Retry.
  const [llmFailed, setLlmFailed] = useState<string | null>(null);
  const pollDeadlineRef = useRef(0);
  const [highlightLlm, setHighlightLlm] = useState(false);
  // Stand von llmEnrichedAt beim Start eines KI-Laufs — Fertig = Wert hat sich
  // geändert (deckt Erstlauf null→Zeit UND Re-Run alt→neu ab).
  const llmBaselineRef = useRef<string | null>(null);

  const beginLlmRun = useCallback(() => {
    llmBaselineRef.current = enriched;
    // CPU-only ist voll unterstützt, aber bewusst als Bottleneck ausgewiesen.
    // Modell-Warmlauf + Inferenz können zusammen deutlich über zehn Minuten liegen.
    pollDeadlineRef.current = Date.now() + 30 * 60_000;
    setLlmFailed(null);
    setLlmJobState('waiting');
    setLlmWorkerAvailable(null);
    setPollLlm(true);
  }, [enriched, setLlmFailed, setLlmJobState, setLlmWorkerAvailable, setPollLlm]);

  useEffect(() => {
    if (!engineConfigured) return;
    let active = true;
    const tick = () => {
      void (async () => {
        if (pollLlm && Date.now() > pollDeadlineRef.current) {
          setPollLlm(false);
          setLlmJobState(null);
          setLlmWorkerAvailable(null);
          onInfo(
            'Die KI-Vertiefung läuft im Hintergrund weiter — die Markierungen erscheinen beim nächsten Öffnen.',
          );
          return;
        }
        const r = await llmStatusAction({ clientId, analysisId: analysisId });
        if (!active || !r.ok) return;
        setLlm(r.status);
        setLlmJobState(r.jobState);
        setLlmWorkerAvailable(r.workerAvailable);
        // Läuft serverseitig ein Job (z. B. nach einem Page-Reload — der Client-
        // State ist dann weg, der Job-Zustand aber bekannt)? → „läuft"-Polling
        // wieder aufnehmen, damit Statusanzeige + Trigger-Sperre erneut greifen.
        if (!pollLlm && r.jobRunning) {
          beginLlmRun();
          setLlmJobState(r.jobState);
          setLlmWorkerAvailable(r.workerAvailable);
          return;
        }
        if (pollLlm && r.enrichedAt && r.enrichedAt !== llmBaselineRef.current) {
          setHighlightLlm(true);
          setPollLlm(false);
          setLlmJobState(null);
          setLlmWorkerAvailable(null);
          onRefresh(); // weich: Editor/Selektion/Scroll bleiben erhalten
        } else if (pollLlm && r.jobFailed) {
          // Job endgültig gescheitert → „lädt" beenden, Retry anbieten (nicht bis zum
          // 30-Min-Deadline weiterpollen).
          setPollLlm(false);
          setLlmJobState(null);
          setLlmWorkerAvailable(null);
          setLlmFailed(r.jobError || 'Die KI-Vertiefung ist fehlgeschlagen.');
        }
      })().catch((err) => {
        console.warn('[subsumtion] LLM-Status konnte nicht aktualisiert werden', err);
      });
    };
    tick();
    // Ohne aktiven Lauf: nur der eine Mount-Tick (erkennt einen ggf. laufenden
    // Job) — kein 5-s-Intervall.
    if (!pollLlm)
      return () => {
        active = false;
      };
    const iv = setInterval(tick, 5000);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [beginLlmRun, clientId, engineConfigured, enriched, pollLlm, analysisId, onRefresh, onInfo]);

  function stopLlmRun() {
    setPollLlm(false);
    setLlmJobState(null);
    setLlmWorkerAvailable(null);
  }
  return {
    llm,
    pollLlm,
    llmJobState,
    llmWorkerAvailable,
    llmFailed,
    setLlmFailed,
    highlightLlm,
    setHighlightLlm,
    beginLlmRun,
    stopLlmRun,
  };
}
