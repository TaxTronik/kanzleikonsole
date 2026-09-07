'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type RefObject,
} from 'react';
import { useRouter } from 'next/navigation';
import { SubsumtionCompose } from './subsumtion-compose';
import { SubsumtionSelectionPanel } from './subsumtion-selection-panel';
import { SubsumtionReviewControls, SubsumtionLlmFeedback } from './subsumtion-review-controls';
import { useSubsumtionLlm } from './use-subsumtion-llm';
import type { SubsumtionWorkspaceProps } from './workspace-types';
import { FolderOpen, ClipboardList, Webhook } from 'lucide-react';
import { confirmDialog } from '@/components/ui/modal';
import {
  requestLlmAction,
  archiveAnalysisAction,
  reformatAnalysisAction,
  reanalyzeAction,
  setAnalysisVertraulichAction,
} from './actions';
import { DisclaimerBanner } from './disclaimer-banner';
import { StatsBar } from './stats-bar';
import { HerkunftLegende } from './herkunft-legende';
import {
  SubsumtionDocument,
  type SubsumtionDocumentHandle,
  type ManualSelection,
} from './subsumtion-document';
import { ResearchComposer } from './research-composer';
import { MarkingList } from './marking-list';
import { ResearchView } from './research-view';
import { canStartLlm, llmCapabilityError } from '@/lib/risk-llm';
import { type AnalysisDTO, type MarkingDTO, FILTER_KEYS, type FilterKey, isVisible } from './_ui';

function workspaceViewClass(active: boolean, withIcon = false): string {
  const colors = active
    ? 'px-3 py-1.5 bg-brand-600 text-on-brand font-medium'
    : 'px-3 py-1.5 text-secondary hover:bg-gray-50 dark:hover:bg-gray-800';
  return withIcon ? 'inline-flex items-center gap-1.5 ' + colors : colors;
}

type WorkspaceView = 'subsumtion' | 'recherche' | 'aufgaben' | 'aktenregal';
const WORKSPACE_URL_EVENT = 'subsumtion-url-change';

function subscribeWorkspaceUrl(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(WORKSPACE_URL_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(WORKSPACE_URL_EVENT, onChange);
  };
}

function replaceWorkspaceUrl(url: URL) {
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(WORKSPACE_URL_EVENT));
}

function readWorkspaceSearch() {
  return window.location.search;
}

function serverWorkspaceSearch() {
  return '';
}

function useWorkspaceView() {
  const workspaceSearch = useSyncExternalStore(
    subscribeWorkspaceUrl,
    readWorkspaceSearch,
    serverWorkspaceSearch,
  );
  const params = new URLSearchParams(workspaceSearch);
  const fromUrl = params.get('view');
  const view: WorkspaceView =
    fromUrl === 'recherche' || fromUrl === 'aufgaben' || fromUrl === 'aktenregal'
      ? fromUrl
      : 'subsumtion';
  const setView = useCallback((next: WorkspaceView) => {
    const url = new URL(window.location.href);
    if (next === 'subsumtion') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    replaceWorkspaceUrl(url);
  }, []);
  return { view, setView, wantedMarking: params.get('marking') };
}

function useMarkingDeeplink(
  wantedMarking: string | null,
  markingsById: Record<string, MarkingDTO>,
  editorRef: RefObject<SubsumtionDocumentHandle | null>,
  setSelectedId: (value: string | null) => void,
  setManualSel: (value: ManualSelection | null) => void,
) {
  const [consumedDeeplink, setConsumedDeeplink] = useState<string | null>(null);
  if (wantedMarking && wantedMarking !== consumedDeeplink && markingsById[wantedMarking]) {
    setConsumedDeeplink(wantedMarking);
    setSelectedId(wantedMarking);
    setManualSel(null);
  }
  useEffect(() => {
    if (!consumedDeeplink) return;
    const marking = markingsById[consumedDeeplink];
    if (!marking) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('marking') !== consumedDeeplink) return;
    editorRef.current?.revealMarking(marking.start);
    // Parameter entfernen, damit ein Reload nicht erneut springt.
    url.searchParams.delete('marking');
    replaceWorkspaceUrl(url);
  }, [consumedDeeplink, markingsById, editorRef]);
}

function useLlmCompletion({
  enriched,
  highlightLlm,
  setHighlightLlm,
  markings,
  manualSel,
  selectedId,
  setInfo,
  setSelectedId,
}: {
  enriched: string | null;
  highlightLlm: boolean;
  setHighlightLlm: (value: boolean) => void;
  markings: MarkingDTO[];
  manualSel: ManualSelection | null;
  selectedId: string | null;
  setInfo: (value: string) => void;
  setSelectedId: (value: string) => void;
}) {
  const [prevEnriched, setPrevEnriched] = useState(enriched);
  if (prevEnriched !== enriched) {
    setPrevEnriched(enriched);
    if (highlightLlm && enriched) {
      setHighlightLlm(false);
      const llmMarks = markings.filter((m) => m.herkunft === 'LLM' || m.herkunft === 'EMBEDDING');
      setInfo(
        llmMarks.length > 0
          ? `${llmMarks.length} neue KI-Markierung(en) hinzugefügt.`
          : 'KI-Vertiefung abgeschlossen — die Engine hat keine zusätzlichen Markierungen geliefert (über die deterministischen hinaus).',
      );
      if (llmMarks.length > 0 && !manualSel && !selectedId) setSelectedId(llmMarks[0]!.id);
    }
  }
}

export function SubsumtionWorkspace(props: SubsumtionWorkspaceProps) {
  return props.initial ? (
    <SubsumtionReviewWorkspace {...props} initial={props.initial} />
  ) : (
    <SubsumtionCompose {...props} />
  );
}

function SubsumtionReviewWorkspace({
  clientId,
  canWrite = true,
  currentStaffId,
  staffOptions,
  researchResults = [],
  archivedResearchResults = [],
  researchRequests = [],
  aufgaben,
  aktenregal,
  engineConfigured,
  floatingToolbarDefault = false,
  initial,
}: SubsumtionWorkspaceProps & { initial: AnalysisDTO }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formatError, setFormatError] = useState<string | null>(null);
  const displayError = error ?? formatError;
  const [info, setInfo] = useState<string | null>(null);

  const editorRef = useRef<SubsumtionDocumentHandle>(null);

  // Review: das Panel folgt der Auswahl im Dokument (keine Modi).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<FilterKey>>(() => new Set(FILTER_KEYS));
  const [manualSel, setManualSel] = useState<ManualSelection | null>(null);
  const [showCaseResearch, setShowCaseResearch] = useState(false);
  // Der aktive Tab wird in der URL (?view=…) gespiegelt: übersteht so JEDEN
  // Remount (AutoRefresh/RSC-Refresh konnte den Nutzer sonst „von alleine"
  // zurück auf Subsumtion werfen) und ist gleichzeitig deeplinkfähig.
  // history.replaceState statt router.replace: kein Server-Roundtrip pro Klick.
  const { view, setView, wantedMarking } = useWorkspaceView();
  // Vollbild der Subsumtions-Fläche (Dokument + Panel als Overlay). Esc verlässt es.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);
  // Erfolgs-/Info-Meldungen blenden sich nach kurzer Zeit selbst aus (Toast-
  // Verhalten); Fehler bleiben stehen, bis sie durch die nächste Aktion ersetzt
  // werden. Einheitliches Feedback-Muster.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 4500);
    return () => clearTimeout(t);
  }, [info]);

  const enriched = initial.llmEnrichedAt;
  const refresh = useCallback(() => router.refresh(), [router]);
  const {
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
  } = useSubsumtionLlm({
    clientId,
    analysisId: initial.id,
    engineConfigured,
    enriched,
    onRefresh: refresh,
    onInfo: setInfo,
  });

  // Cursor in einer Markierung → inspizieren; Auswahl (Ziehen) → eigene Markierung.
  function selectMarking(id: string | null) {
    setSelectedId(id);
    if (id) setManualSel(null);
  }
  function selectForMarking(sel: ManualSelection | null) {
    setManualSel(sel);
    if (sel) setSelectedId(null);
  }

  const markings = initial.markings;
  const visibleMarkings = useMemo(
    () => markings.filter((m) => isVisible(m, filters)),
    [markings, filters],
  );
  const selected = markings.find((m) => m.id === selectedId) ?? null;
  const ownCount = markings.filter((m) => m.herkunft === 'BERATER').length;
  const newResultCount = researchResults.filter((r) => r.status === 'NEU').length;
  const markingsById = useMemo(
    () => Object.fromEntries(markings.map((m) => [m.id, m])) as Record<string, MarkingDTO>,
    [markings],
  );
  // Sichtbare Markierungen in Lese-Reihenfolge (für Liste + Alt+↑/↓-Stepping).
  const orderedVisible = useMemo(
    () =>
      [...visibleMarkings].sort(
        (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id),
      ),
    [visibleMarkings],
  );

  // Auswahl aus der Liste/Navigation: markieren + im Dokument in den Sichtbereich
  // scrollen (revealMarking setzt den Cursor → onSelectionUpdate wählt sie ohnehin).
  function selectAndReveal(id: string) {
    setSelectedId(id);
    setManualSel(null);
    const m = markingsById[id];
    if (m) editorRef.current?.revealMarking(m.start);
  }
  function stepMarking(dir: 1 | -1) {
    if (orderedVisible.length === 0) return;
    const idx = orderedVisible.findIndex((m) => m.id === selectedId);
    const next =
      idx === -1
        ? dir === 1
          ? orderedVisible[0]
          : orderedVisible[orderedVisible.length - 1]
        : orderedVisible[(idx + dir + orderedVisible.length) % orderedVisible.length];
    if (next) selectAndReveal(next.id);
  }

  // Alt+↑/↓ steppt durch die Markierungen (Alt verhindert Konflikt mit der
  // Texteingabe im Editor). Ref hält die frische Closure → Listener bindet einmal.
  const stepRef = useRef(stepMarking);
  useEffect(() => {
    stepRef.current = stepMarking;
  });

  // Deeplink `?marking=<id>` aus der Zuweisungs-Benachrichtigung: die
  // betroffene Markierung auswählen und im Sachverhalt anspringen. Ohne das
  // landet die zugewiesene Person auf der Analyse und muss ihren Begriff
  // zwischen allen anderen suchen.
  useMarkingDeeplink(wantedMarking, markingsById, editorRef, setSelectedId, setManualSel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepRef.current(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepRef.current(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Nach der weichen Aktualisierung (LLM-Lauf fertig): neue KI-Markierungen
  // (LLM/Heuristik) melden + die erste hervorheben — aber NUR, wenn der Bearbeiter
  // gerade nichts offen hat (Auswahl/eigene Markierung), um nicht zu stören.
  useLlmCompletion({
    enriched,
    highlightLlm,
    setHighlightLlm,
    markings,
    manualSel,
    selectedId,
    setInfo,
    setSelectedId,
  });

  function flash(r: { ok: boolean; error?: string }, okMsg?: string) {
    if (!r.ok) {
      setError(r.error ?? 'Fehler.');
      setInfo(null);
    } else {
      setInfo(okMsg ?? null);
      setError(null);
    }
  }

  // --- Review-Aktionen ---
  function requestLlm() {
    if (!canStartLlm(llm)) {
      setError(llmCapabilityError(llm));
      setInfo(null);
      return;
    }
    setError(null);
    start(async () => {
      const r = await requestLlmAction({ clientId, analysisId: initial.id });
      if (!r.ok) {
        flash(r);
        return;
      }
      beginLlmRun(); // Erst nach erfolgreichem Enqueue als „läuft" anzeigen.
      flash(r, 'KI-Vertiefung gestartet — die neuen Markierungen erscheinen hier automatisch.');
    });
  }
  function toggleFilter(k: FilterKey) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  // Auto-Save der Formatierung (on-the-fly, vom Editor debounced aufgerufen).
  // Still: kein Toast/Refresh — der Editor hält den Stand schon; Status zeigt die
  // Fläche selbst. Nur bei Fehler wird der Fehlerbanner gesetzt.
  async function saveFormat(doc: unknown): Promise<{ ok: boolean; error?: string }> {
    const r = await reformatAnalysisAction({ clientId, analysisId: initial.id, doc });
    setFormatError(r.ok ? null : (r.error ?? 'Formatierung konnte nicht gespeichert werden.'));
    return r;
  }
  function reanalyze() {
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await reanalyzeAction({ clientId, analysisId: initial.id });
      if (!r.ok) {
        setError(r.error);
        stopLlmRun();
        return;
      }
      if (r.llmQueued) beginLlmRun();
      setInfo(
        (r.added > 0
          ? `Neu analysiert — ${r.added} neue Markierung(en) ergänzt`
          : 'Neu analysiert — keine neuen deterministischen Markierungen') +
          (r.llmQueued ? '; KI-Vertiefung läuft …' : '') +
          ' (Bewertungen bleiben).',
      );
      refresh(); // deterministische Ergänzungen sofort zeigen; KI folgt automatisch
    });
  }
  async function archive() {
    if (
      !(await confirmDialog(
        'Subsumtion revisionssicher archivieren? Danach ist sie schreibgeschützt (GoBD-Snapshot, Object-Lock).',
        { title: 'Subsumtion archivieren', confirmLabel: 'Revisionssicher archivieren' },
      ))
    )
      return;
    setError(null);
    start(async () => {
      const r = await archiveAnalysisAction({ clientId, analysisId: initial.id });
      flash(r, 'Subsumtion revisionssicher archiviert (schreibgeschützt).');
      if (r.ok) refresh();
    });
  }

  function toggleVertraulich() {
    const an = !initial.vertraulich;
    setError(null);
    start(async () => {
      const r = await setAnalysisVertraulichAction({ analysisId: initial.id, vertraulich: an });
      flash(
        r,
        an
          ? 'Als vertraulich gekennzeichnet — Zugewiesene sehen nur ihre Textstelle.'
          : 'Vertraulichkeit aufgehoben.',
      );
      if (r.ok) refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // REVIEW-MODUS
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-3">
      <DisclaimerBanner />

      <StatsBar
        markings={markings}
        llmEnrichedAt={initial.llmEnrichedAt}
        engineConfigured={engineConfigured}
        pending={pending}
        onRequestLlm={requestLlm}
        llmStatus={llm}
        llmStarting={pollLlm}
        llmJobState={llmJobState}
        llmWorkerAvailable={llmWorkerAvailable}
      />

      {/* View-Umschalter: Subsumtion ⇆ Recherche-Hub */}
      <div className="inline-flex rounded-md border border-default overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setView('subsumtion')}
          className={workspaceViewClass(view === 'subsumtion')}
        >
          Subsumtion
        </button>
        <button
          type="button"
          onClick={() => setView('recherche')}
          className={workspaceViewClass(view === 'recherche', true)}
        >
          <Webhook className="h-3.5 w-3.5" /> Recherche
          {newResultCount > 0 && <span className="badge-yellow text-[10px]">{newResultCount}</span>}
        </button>
        <button
          type="button"
          onClick={() => setView('aufgaben')}
          className={workspaceViewClass(view === 'aufgaben', true)}
        >
          <ClipboardList className="h-3.5 w-3.5" /> Aufgaben
        </button>
        <button
          type="button"
          onClick={() => setView('aktenregal')}
          className={workspaceViewClass(view === 'aktenregal', true)}
        >
          <FolderOpen className="h-3.5 w-3.5" /> Aktenregal
        </button>
      </div>

      {displayError && <div className="alert-error-sm">{displayError}</div>}
      {info && <div className="text-sm text-emerald-700 dark:text-emerald-300">{info}</div>}

      {/* Beide Ansichten bleiben gemountet (CSS-Umschaltung statt Unmount) — sonst
          würde der Tiptap-Editor beim Wechsel neu mounten (Flackern, Scroll-/
          Auswahl-Verlust, evtl. verwaiste Overlays). So ist der Wechsel instant. */}
      <div className={view === 'recherche' ? undefined : 'hidden'}>
        <ResearchView
          clientId={clientId}
          analysisId={initial.id}
          requests={researchRequests}
          results={researchResults}
          archivedResults={archivedResearchResults}
          markingsById={markingsById}
          staffOptions={staffOptions}
          engineConfigured={engineConfigured}
          pending={pending}
          start={start}
          onFlash={flash}
          onSelectMarking={(id) => {
            setView('subsumtion');
            selectAndReveal(id);
          }}
        />
      </div>

      <div className={view === 'aufgaben' ? '' : 'hidden'}>{aufgaben}</div>

      <div className={view === 'aktenregal' ? '' : 'hidden'}>{aktenregal}</div>

      <div className={view === 'subsumtion' ? 'space-y-3' : 'hidden'}>
        <SubsumtionReviewControls
          clientId={clientId}
          initial={initial}
          canWrite={canWrite}
          pending={pending}
          engineConfigured={engineConfigured}
          pollLlm={pollLlm}
          onReanalyze={reanalyze}
          onArchive={archive}
          onToggleCaseResearch={() => setShowCaseResearch((v) => !v)}
          onToggleVertraulich={toggleVertraulich}
          markings={markings}
        />

        {showCaseResearch && (
          <div>
            <ResearchComposer
              clientId={clientId}
              analysisId={initial.id}
              markingId={null}
              pending={pending}
              start={start}
              onClose={() => setShowCaseResearch(false)}
              onDone={(r) => {
                flash(r, 'Anonymisierter Auftrag (ganzer Fall) an n8n gesendet.');
                if (r.ok) setShowCaseResearch(false);
              }}
            />
          </div>
        )}

        <HerkunftLegende />

        <SubsumtionLlmFeedback
          pollLlm={pollLlm}
          llmJobState={llmJobState}
          llmWorkerAvailable={llmWorkerAvailable}
          llmFailed={llmFailed}
          setLlmFailed={setLlmFailed}
          requestLlm={requestLlm}
          pending={pending}
          engineConfigured={engineConfigured}
          archived={!!initial.archivedAt}
        />

        <div
          className={
            expanded
              ? 'fixed inset-0 z-40 overflow-auto bg-surface-page p-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4'
              : 'grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4'
          }
        >
          {/* EINE Fläche: immer formatiert + editierbar. Klicken = Markierung prüfen,
            Ziehen = eigene Markierung, Toolbar = formatieren. Alt-Analysen ohne
            sourceDoc werden aus dem Plaintext geseedet (offsets bleiben gleich). */}
          <SubsumtionDocument
            ref={editorRef}
            analyzed
            canEdit={!initial.archivedAt && canWrite}
            initialDoc={initial.sourceDoc ?? null}
            initialText={initial.sourceText}
            sourceText={initial.sourceText}
            textHash={initial.textHash}
            totalCount={markings.length}
            ownCount={ownCount}
            visibleMarkings={visibleMarkings}
            filters={filters}
            onToggleFilter={toggleFilter}
            selectedId={selectedId}
            onSelectMarking={selectMarking}
            onSelectionForMarking={selectForMarking}
            onSaveFormat={saveFormat}
            floatingToolbarDefault={floatingToolbarDefault}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
          />

          {/* Sticky: Panel bleibt beim Scrollen sichtbar — Klick auf eine Markierung
            weit unten muss nicht zurück nach oben gescrollt werden. self-start
            verhindert das Grid-Stretching (sonst greift sticky nicht); bei langem
            Panel scrollt es intern. */}
          <div className="lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto space-y-3">
            <MarkingList
              markings={orderedVisible}
              selectedId={selectedId}
              onSelect={selectAndReveal}
              onPrev={() => stepMarking(-1)}
              onNext={() => stepMarking(1)}
            />
            <SubsumtionSelectionPanel
              clientId={clientId}
              analysisId={initial.id}
              manualSel={manualSel}
              canWrite={canWrite}
              currentStaffId={currentStaffId}
              selected={selected}
              researchResults={researchResults}
              staffOptions={staffOptions}
              engineConfigured={engineConfigured}
              pending={pending}
              start={start}
              flash={flash}
              refresh={refresh}
              setManualSel={setManualSel}
              setSelectedId={setSelectedId}
              pollLlm={pollLlm}
              llm={llm}
              llmJobState={llmJobState}
              llmWorkerAvailable={llmWorkerAvailable}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
