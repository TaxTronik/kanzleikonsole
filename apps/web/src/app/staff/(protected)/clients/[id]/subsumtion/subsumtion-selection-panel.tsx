'use client';
import { Loader2 } from 'lucide-react';
import type { TransitionStartFunction } from 'react';
import type { LlmStatusDTO } from '@/server/risk/llm';
import type { ManualSelection } from './subsumtion-document';
import { MarkingPanel } from './marking-panel';
import { NewMarkingPanel } from './new-marking-panel';
import type { MarkingDTO, ResearchResultDTO, Flash } from './_ui';

/** Skeleton im Panel, während die LLM-Phase läuft — statt eines harten Reloads:
 *  „lade, du kannst weiterarbeiten". Die fertigen Markierungen kommen automatisch. */
function LlmDeepeningCard({
  status,
  jobState,
  workerAvailable,
}: {
  status: LlmStatusDTO | null;
  jobState: string | null;
  workerAvailable: boolean | null;
}) {
  const waiting = jobState !== 'active';
  const label = waiting
    ? workerAvailable === false
      ? 'KI-Vertiefung wartet auf den Hintergrund-Worker …'
      : 'KI-Vertiefung steht in der Warteschlange …'
    : status?.verfuegbar
      ? 'KI analysiert den Sachverhalt …'
      : 'KI-Modell wird geladen …';
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm text-primary">
        <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
        <span>{label}</span>
      </div>
      <p className="text-xs text-muted">
        {workerAvailable === false
          ? 'Es ist noch kein Worker verbunden. Lokal startet „pnpm dev“ Web und Worker gemeinsam.'
          : 'Neue KI-Markierungen erscheinen automatisch — du kannst in der Zwischenzeit weiterarbeiten.'}
      </p>
      <div className="space-y-2 animate-pulse" aria-hidden>
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-3/4" />
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-1/2" />
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-2/3" />
      </div>
    </div>
  );
}

export function SubsumtionSelectionPanel({
  clientId,
  analysisId,
  manualSel,
  canWrite,
  currentStaffId,
  selected,
  researchResults,
  staffOptions,
  engineConfigured,
  pending,
  start,
  flash,
  refresh,
  setManualSel,
  setSelectedId,
  pollLlm,
  llm,
  llmJobState,
  llmWorkerAvailable,
}: {
  clientId: string;
  analysisId: string;
  manualSel: ManualSelection | null;
  canWrite: boolean;
  currentStaffId?: string;
  selected: MarkingDTO | null;
  researchResults: ResearchResultDTO[];
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: TransitionStartFunction;
  flash: Flash;
  refresh: () => void;
  setManualSel: (value: ManualSelection | null) => void;
  setSelectedId: (id: string | null) => void;
  pollLlm: boolean;
  llm: LlmStatusDTO | null;
  llmJobState: string | null;
  llmWorkerAvailable: boolean | null;
}) {
  return (
    <>
      {manualSel && canWrite ? (
        <NewMarkingPanel
          clientId={clientId}
          analysisId={analysisId}
          selection={manualSel}
          pending={pending}
          start={start}
          onDone={(r) => {
            flash(r, 'Markierung hinzugefügt.');
            if (r.ok) {
              setManualSel(null);
              refresh();
            }
          }}
        />
      ) : selected ? (
        <MarkingPanel
          // Das Panel leitet sein Formular einmalig aus `marking` ab. „Zuweisen"
          // (Delegation) ändert status/verantwortlichId aber serverseitig hinter
          // dem offenen Panel — diese Felder in den Key aufnehmen, damit das Panel
          // nach dem Refresh neu mountet und den Server-Stand übernimmt (sonst
          // würde ein späteres „Speichern" die Zuweisung überschreiben).
          key={`${selected.id}:${selected.status}:${selected.verantwortlichId ?? ''}`}
          canWrite={canWrite}
          isAssignee={selected.verantwortlichId === currentStaffId}
          // Ergebnisse dieser Markierung — die Prüfung findet dort statt,
          // wo die Zuweisung hinführt, nicht in einem separaten Tab.
          results={researchResults.filter((r) => r.markingId === selected.id)}
          clientId={clientId}
          analysisId={analysisId}
          marking={selected}
          staffOptions={staffOptions}
          engineConfigured={engineConfigured}
          pending={pending}
          start={start}
          onChanged={refresh}
          onClose={() => setSelectedId(null)}
          flash={flash}
        />
      ) : pollLlm ? (
        <LlmDeepeningCard
          status={llm}
          jobState={llmJobState}
          workerAvailable={llmWorkerAvailable}
        />
      ) : (
        <div className="card p-4 text-sm text-muted">
          <strong>Klicken</strong> Sie eine Markierung im Text an, um sie zu bewerten, zu delegieren
          oder zu definieren — oder <strong>ziehen</strong> Sie über eine Stelle, um eine eigene
          Markierung zu setzen.
        </div>
      )}
    </>
  );
}
