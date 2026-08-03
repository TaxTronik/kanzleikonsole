'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
  type ChangeEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Sparkles,
  Upload,
  Loader2,
  FileDown,
  FolderOpen,
  ClipboardList,
  Webhook,
  Archive,
  Lock,
  RefreshCw,
  X,
  AlertTriangle,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  analyzeAction,
  importDocTextAction,
  importClientDocAction,
  requestLlmAction,
  archiveAnalysisAction,
  reformatAnalysisAction,
  llmStatusAction,
  reanalyzeAction,
  setAnalysisVertraulichAction,
} from './actions';
import type { LlmStatusDTO } from '@/server/risk/llm';
import { DisclaimerBanner } from './disclaimer-banner';
import { StatsBar } from './stats-bar';
import { HerkunftLegende } from './herkunft-legende';
import {
  SubsumtionDocument,
  type SubsumtionDocumentHandle,
  type ManualSelection,
} from './subsumtion-document';
import { MarkingPanel } from './marking-panel';
import { ResearchComposer } from './research-composer';
import { NewMarkingPanel } from './new-marking-panel';
import { ExportPanel } from './export-panel';
import { MarkingList } from './marking-list';
import { ResearchView } from './research-view';
import { fmtDateShort } from '@/lib/fmt';
import {
  type AnalysisDTO,
  type ResearchResultDTO,
  type ResearchRequestDTO,
  type MarkingDTO,
  FILTER_KEYS,
  type FilterKey,
  isVisible,
} from './_ui';

/** Skeleton im Panel, während die LLM-Phase läuft — statt eines harten Reloads:
 *  „lade, du kannst weiterarbeiten". Die fertigen Markierungen kommen automatisch. */
function LlmDeepeningCard({ status }: { status: LlmStatusDTO | null }) {
  const label = status?.verfuegbar ? 'KI analysiert den Sachverhalt …' : 'KI-Modell wird geladen …';
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm text-primary">
        <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
        <span>{label}</span>
      </div>
      <p className="text-xs text-muted">
        Neue KI-Markierungen erscheinen automatisch — du kannst in der Zwischenzeit weiterarbeiten.
      </p>
      <div className="space-y-2 animate-pulse" aria-hidden>
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-3/4" />
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-1/2" />
        <div className="h-3 rounded bg-gray-200 dark:bg-gray-700 w-2/3" />
      </div>
    </div>
  );
}

interface Props {
  clientId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  clientDocuments: Array<{ id: string; title: string; mimeType: string; typeName: string }>;
  researchResults?: ResearchResultDTO[];
  archivedResearchResults?: ResearchResultDTO[];
  researchRequests?: ResearchRequestDTO[];
  /** Server-gerenderter Inhalt des „Aufgaben"-Tabs (Workflows dieses Sachverhalts). */
  aufgaben?: ReactNode;
  /** Server-gerenderter Inhalt des „Aktenregal"-Tabs (Dokumente dieses Sachverhalts). */
  aktenregal?: ReactNode;
  engineConfigured: boolean;
  initial: AnalysisDTO | null;
  /**
   * Volle Bearbeitungsrechte. Ohne sie sieht der Space lesend aus; recherchiert
   * werden darf nur an zugewiesenen Markierungen. Reine Anzeige-Logik — die
   * Durchsetzung liegt in den Server Actions.
   */
  canWrite?: boolean;
  /** Eigene Staff-ID — entscheidet, ob eine Markierung „mir zugewiesen" ist. */
  currentStaffId?: string;
}

const EMPTY_MARKINGS: MarkingDTO[] = [];

export function SubsumtionWorkspace({
  clientId,
  canWrite = true,
  currentStaffId,
  staffOptions,
  clientDocuments,
  researchResults = [],
  archivedResearchResults = [],
  researchRequests = [],
  aufgaben,
  aktenregal,
  engineConfigured,
  initial,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Compose-Modus
  const [text, setText] = useState(initial?.sourceText ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [docId, setDocId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<SubsumtionDocumentHandle>(null);

  // Importierten Text in den Editor schieben (an vorhandenen Text anhängen).
  function appendToEditor(imported: string) {
    const cur = editorRef.current?.getText() ?? '';
    editorRef.current?.setText(cur.trim() ? cur + '\n\n' + imported : imported);
  }

  // Review: das Panel folgt der Auswahl im Dokument (keine Modi).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Set<FilterKey>>(() => new Set(FILTER_KEYS));
  const [manualSel, setManualSel] = useState<ManualSelection | null>(null);
  const [showCaseResearch, setShowCaseResearch] = useState(false);
  // Der aktive Tab wird in der URL (?view=…) gespiegelt: übersteht so JEDEN
  // Remount (AutoRefresh/RSC-Refresh konnte den Nutzer sonst „von alleine"
  // zurück auf Subsumtion werfen) und ist gleichzeitig deeplinkfähig.
  // history.replaceState statt router.replace: kein Server-Roundtrip pro Klick.
  type WorkspaceView = 'subsumtion' | 'recherche' | 'aufgaben' | 'aktenregal';
  const [view, setViewState] = useState<WorkspaceView>('subsumtion');
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('view');
    if (fromUrl === 'recherche' || fromUrl === 'aufgaben' || fromUrl === 'aktenregal') {
      setViewState(fromUrl);
    }
  }, []);
  const setView = useCallback((next: WorkspaceView) => {
    setViewState(next);
    const url = new URL(window.location.href);
    if (next === 'subsumtion') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    window.history.replaceState(null, '', url);
  }, []);
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

  // LLM-Status (Schicht 2): einmal beim Mount holen; nach „LLM dazuschalten"
  // engmaschig pollen. Ist der Lauf fertig (llmEnrichedAt gesetzt), WEICH
  // aktualisieren (router.refresh — der Editor/Cursor/Scroll bleibt erhalten) und
  // die neuen KI-Markierungen hervorheben. Kein harter Reload.
  const [llm, setLlm] = useState<LlmStatusDTO | null>(null);
  const [pollLlm, setPollLlm] = useState(false);
  // Final fehlgeschlagener KI-Lauf (Worker-Job). Beendet das „lädt" und bietet Retry.
  const [llmFailed, setLlmFailed] = useState<string | null>(null);
  const enriched = initial?.llmEnrichedAt ?? null;
  const pollDeadlineRef = useRef(0);
  const highlightLlmRef = useRef(false);
  const prevEnrichedRef = useRef<string | null>(enriched);
  // Stand von llmEnrichedAt beim Start eines KI-Laufs — Fertig = Wert hat sich
  // geändert (deckt Erstlauf null→Zeit UND Re-Run alt→neu ab).
  const llmBaselineRef = useRef<string | null>(null);

  const beginLlmRun = useCallback(() => {
    llmBaselineRef.current = enriched;
    pollDeadlineRef.current = Date.now() + 10 * 60_000;
    setLlmFailed(null);
    setPollLlm(true);
  }, [enriched]);

  useEffect(() => {
    if (!engineConfigured) {
      setLlm(null);
      return;
    }
    let active = true;
    const tick = () => {
      void (async () => {
        if (pollLlm && Date.now() > pollDeadlineRef.current) {
          setPollLlm(false);
          setInfo(
            'Die KI-Vertiefung läuft im Hintergrund weiter — die Markierungen erscheinen beim nächsten Öffnen.',
          );
          return;
        }
        const r = await llmStatusAction({ clientId, analysisId: initial?.id });
        if (!active || !r.ok) return;
        setLlm(r.status);
        // Läuft serverseitig ein Job (z. B. nach einem Page-Reload — der Client-
        // State ist dann weg, der Job-Zustand aber bekannt)? → „läuft"-Polling
        // wieder aufnehmen, damit Statusanzeige + Trigger-Sperre erneut greifen.
        if (!pollLlm && r.jobRunning) {
          beginLlmRun();
          return;
        }
        if (pollLlm && r.enrichedAt && r.enrichedAt !== llmBaselineRef.current) {
          highlightLlmRef.current = true;
          setPollLlm(false);
          router.refresh(); // weich: Editor/Selektion/Scroll bleiben erhalten
        } else if (pollLlm && r.jobFailed) {
          // Job endgültig gescheitert → „lädt" beenden, Retry anbieten (nicht bis zum
          // 10-Min-Deadline weiterpollen).
          setPollLlm(false);
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
  }, [beginLlmRun, clientId, engineConfigured, enriched, pollLlm, initial?.id, router]);

  // Cursor in einer Markierung → inspizieren; Auswahl (Ziehen) → eigene Markierung.
  function selectMarking(id: string | null) {
    setSelectedId(id);
    if (id) setManualSel(null);
  }
  function selectForMarking(sel: ManualSelection | null) {
    setManualSel(sel);
    if (sel) setSelectedId(null);
  }

  const markings = initial?.markings ?? EMPTY_MARKINGS;
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
  stepRef.current = stepMarking;

  // Deeplink `?marking=<id>` aus der Zuweisungs-Benachrichtigung: die
  // betroffene Markierung auswählen und im Sachverhalt anspringen. Ohne das
  // landet die zugewiesene Person auf der Analyse und muss ihren Begriff
  // zwischen allen anderen suchen.
  const deeplinkRef = useRef(false);
  useEffect(() => {
    if (deeplinkRef.current) return;
    const wanted = new URLSearchParams(window.location.search).get('marking');
    if (!wanted || !markingsById[wanted]) return;
    deeplinkRef.current = true;
    selectAndReveal(wanted);
    // Parameter entfernen, damit ein Reload nicht erneut springt.
    const url = new URL(window.location.href);
    url.searchParams.delete('marking');
    window.history.replaceState(null, '', url);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- einmalig, sobald die Markierungen geladen sind
  }, [markingsById]);

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
  useEffect(() => {
    const was = prevEnrichedRef.current;
    prevEnrichedRef.current = enriched;
    // Nur beim tatsächlichen Wechsel von llmEnrichedAt (Erstlauf ODER Re-Run).
    if (!highlightLlmRef.current || !enriched || was === enriched) return;
    highlightLlmRef.current = false;
    const llmMarks = markings.filter((m) => m.herkunft === 'LLM' || m.herkunft === 'EMBEDDING');
    setInfo(
      llmMarks.length > 0
        ? `${llmMarks.length} neue KI-Markierung(en) hinzugefügt.`
        : 'KI-Vertiefung abgeschlossen — die Engine hat keine zusätzlichen Markierungen geliefert (über die deterministischen hinaus).',
    );
    if (llmMarks.length > 0 && !manualSel && !selectedId) setSelectedId(llmMarks[0]!.id);
  }, [enriched, markings, manualSel, selectedId]);

  function flash(r: { ok: boolean; error?: string }, okMsg?: string) {
    if (!r.ok) {
      setError(r.error ?? 'Fehler.');
      setInfo(null);
    } else {
      setInfo(okMsg ?? null);
      setError(null);
    }
  }
  function refresh() {
    router.refresh();
  }

  // --- Compose-Aktionen ---
  function analyze() {
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await analyzeAction({
        clientId,
        text,
        title: title.trim() || undefined,
        doc: editorRef.current?.getDoc() ?? undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/staff/clients/${clientId}/subsumtion/${r.analysisId}`);
    });
  }
  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setInfo(null);
    start(async () => {
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('file', file);
      const r = await importDocTextAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      appendToEditor(r.text);
      // Titel-Vorschlag nur übernehmen, wenn noch keiner gesetzt ist.
      if (r.suggestedTitle && !title.trim()) setTitle(r.suggestedTitle);
      setInfo('Text aus Dokument übernommen.');
    });
  }
  function importExisting() {
    if (!docId) return;
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await importClientDocAction({ clientId, documentId: docId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      appendToEditor(r.text);
      if (r.suggestedTitle && !title.trim()) setTitle(r.suggestedTitle);
      setInfo('Text aus Mandanten-Dokument übernommen.');
    });
  }

  // --- Review-Aktionen ---
  function requestLlm() {
    if (!initial) return;
    setError(null);
    beginLlmRun(); // Status engmaschig pollen + Fertig-Erkennung scharf stellen
    start(async () => {
      const r = await requestLlmAction({ clientId, analysisId: initial.id });
      flash(
        r,
        'KI-Vertiefung gestartet — der Server fährt bei Bedarf hoch; die neuen Markierungen erscheinen hier automatisch, sobald der Lauf fertig ist.',
      );
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
    if (!initial) return { ok: false, error: 'Keine Analyse.' };
    const r = await reformatAnalysisAction({ clientId, analysisId: initial.id, doc });
    if (!r.ok) setError(r.error ?? 'Formatierung konnte nicht gespeichert werden.');
    return r;
  }
  function reanalyze() {
    if (!initial) return;
    setError(null);
    setInfo(null);
    beginLlmRun(); // KI-Phase wird serverseitig mit angestoßen → Skeleton/Polling an
    start(async () => {
      const r = await reanalyzeAction({ clientId, analysisId: initial.id });
      if (!r.ok) {
        setError(r.error);
        setPollLlm(false);
        return;
      }
      setInfo(
        (r.added > 0
          ? `Neu analysiert — ${r.added} neue Markierung(en) ergänzt`
          : 'Neu analysiert — keine neuen deterministischen Markierungen') +
          '; KI-Vertiefung läuft … (Bewertungen bleiben).',
      );
      refresh(); // deterministische Ergänzungen sofort zeigen; KI folgt automatisch
    });
  }
  function archive() {
    if (!initial) return;
    if (
      !window.confirm(
        'Subsumtion revisionssicher archivieren? Danach ist sie schreibgeschützt (GoBD-Snapshot, Object-Lock).',
      )
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
    if (!initial) return;
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
  // COMPOSE-MODUS (neue Subsumtion)
  // ---------------------------------------------------------------------------
  if (!initial) {
    return (
      <div className="space-y-3">
        <DisclaimerBanner />
        {!engineConfigured && (
          <div className="alert-error-sm">
            Die Risk-Engine ist nicht konfiguriert — Analyse derzeit nicht möglich. Sachverhalt kann
            erfasst, aber noch nicht analysiert werden.
          </div>
        )}
        {error && <div className="alert-error-sm">{error}</div>}
        {info && <div className="text-sm text-emerald-700 dark:text-emerald-300">{info}</div>}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Bezeichnung (optional), z. B. „Umstrukturierung M-Gruppe“"
          className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted">
          Sachverhalt erfassen oder aus einem Dokument importieren — formatieren, bei fragmentierten
          Importen „Absätze zusammenführen" nutzen. Beim Analysieren zählt der reine Text.
        </p>
        <SubsumtionDocument
          ref={editorRef}
          analyzed={false}
          canEdit
          initialDoc={null}
          initialText=""
          onTextChange={setText}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={analyze}
            disabled={pending || !engineConfigured || !text.trim()}
            className="btn-primary text-sm"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Analysieren
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            className="btn-secondary text-sm"
          >
            <Upload className="h-4 w-4" />
            Aus Dokument importieren
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={onFile}
            className="hidden"
          />
          <span className="text-xs text-muted ml-auto">{text.length} Zeichen</span>
        </div>
        {clientDocuments.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
              className="rounded-md border border-default bg-surface px-2 py-1.5 text-sm max-w-[60%] truncate"
            >
              <option value="">Aus Mandanten-Dokument (SeaweedFS) wählen …</option>
              {clientDocuments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.typeName ? ` (${d.typeName})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={importExisting}
              disabled={pending || !docId}
              className="btn-secondary text-sm"
            >
              <FileDown className="h-4 w-4" /> Übernehmen
            </button>
          </div>
        )}
      </div>
    );
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
      />

      {/* View-Umschalter: Subsumtion ⇆ Recherche-Hub */}
      <div className="inline-flex rounded-md border border-default overflow-hidden text-xs">
        <button
          type="button"
          onClick={() => setView('subsumtion')}
          className={
            view === 'subsumtion'
              ? 'px-3 py-1.5 bg-brand-600 text-white font-medium'
              : 'px-3 py-1.5 text-secondary hover:bg-gray-50 dark:hover:bg-gray-800'
          }
        >
          Subsumtion
        </button>
        <button
          type="button"
          onClick={() => setView('recherche')}
          className={
            'inline-flex items-center gap-1.5 ' +
            (view === 'recherche'
              ? 'px-3 py-1.5 bg-brand-600 text-white font-medium'
              : 'px-3 py-1.5 text-secondary hover:bg-gray-50 dark:hover:bg-gray-800')
          }
        >
          <Webhook className="h-3.5 w-3.5" /> Recherche
          {newResultCount > 0 && <span className="badge-yellow text-[10px]">{newResultCount}</span>}
        </button>
        <button
          type="button"
          onClick={() => setView('aufgaben')}
          className={
            'inline-flex items-center gap-1.5 ' +
            (view === 'aufgaben'
              ? 'px-3 py-1.5 bg-brand-600 text-white font-medium'
              : 'px-3 py-1.5 text-secondary hover:bg-gray-50 dark:hover:bg-gray-800')
          }
        >
          <ClipboardList className="h-3.5 w-3.5" /> Aufgaben
        </button>
        <button
          type="button"
          onClick={() => setView('aktenregal')}
          className={
            'inline-flex items-center gap-1.5 ' +
            (view === 'aktenregal'
              ? 'px-3 py-1.5 bg-brand-600 text-white font-medium'
              : 'px-3 py-1.5 text-secondary hover:bg-gray-50 dark:hover:bg-gray-800')
          }
        >
          <FolderOpen className="h-3.5 w-3.5" /> Aktenregal
        </button>
      </div>

      {error && <div className="alert-error-sm">{error}</div>}
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
        {/* Toolbar — bestehende TaxTronik-Features verlinkt */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/staff/clients/${clientId}/subsumtion/new`}
            className="btn-secondary text-xs"
          >
            ‹ Neue Analyse
          </Link>
          <ExportPanel clientId={clientId} analysisId={initial.id} markings={markings} />
          {initial.archivedAt ? (
            <span
              className="badge-gray text-xs inline-flex items-center gap-1 ml-auto"
              title="Revisionssicher archiviert (Object-Lock)"
            >
              <Lock className="h-3.5 w-3.5" /> Archiviert{' '}
              {fmtDateShort(new Date(initial.archivedAt))}
            </span>
          ) : !canWrite ? (
            <span
              className="badge-gray text-xs inline-flex items-center gap-1 ml-auto"
              title="Bearbeitung nur durch Admin/Partner oder zuständige Berufsträger"
            >
              <Lock className="h-3.5 w-3.5" /> Leseansicht
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={reanalyze}
                disabled={pending || !engineConfigured || pollLlm}
                className="btn-secondary text-xs ml-auto"
                title="Engine erneut (deterministisch) laufen lassen — ergänzt nur neue Markierungen, deine Bewertungen bleiben"
              >
                {pending || pollLlm ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}{' '}
                Neu analysieren
              </button>
              <button
                type="button"
                onClick={archive}
                disabled={pending}
                className="btn-secondary text-xs"
                title="Revisionssicher archivieren (GoBD, schreibgeschützt)"
              >
                <Archive className="h-3.5 w-3.5" /> Archivieren
              </button>
              <button
                type="button"
                onClick={() => setShowCaseResearch((v) => !v)}
                className="btn-secondary text-xs"
              >
                <Webhook className="h-3.5 w-3.5" /> Ganzer Fall an KI
              </button>
              <button
                type="button"
                onClick={toggleVertraulich}
                disabled={pending}
                className={initial.vertraulich ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
                title={
                  initial.vertraulich
                    ? 'Vertraulichkeit aufheben — zugewiesene Mitarbeitende sehen dann wieder den ganzen Sachverhalt'
                    : 'Als vertraulich kennzeichnen — zugewiesene Mitarbeitende sehen dann nur ihre Textstelle'
                }
              >
                {initial.vertraulich ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}{' '}
                {initial.vertraulich ? 'Vertraulich' : 'Vertraulich?'}
              </button>
            </>
          )}
        </div>

        {initial.verdeckt && (
          <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/25 px-3 py-2 text-xs text-amber-900 dark:text-amber-100 inline-flex items-center gap-2">
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            Diese Subsumtion ist <strong>vertraulich</strong>. Du siehst ausschliesslich die dir
            zugewiesenen Textstellen — nicht den vollstaendigen Sachverhalt.
          </div>
        )}

        {initial.vertraulich && canWrite && (
          <div className="rounded-md border border-default bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-secondary inline-flex items-center gap-2">
            <EyeOff className="h-3.5 w-3.5 text-disabled shrink-0" />
            Als <strong>vertraulich</strong> gekennzeichnet: Zugewiesene Mitarbeitende ohne
            Schreibrecht sehen nur ihre eigene Textstelle, nicht den ganzen Sachverhalt.
          </div>
        )}

        {initial.archivedAt && (
          <div className="rounded-md border border-default bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-secondary inline-flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-disabled shrink-0" />
            Diese Subsumtion ist <strong>revisionssicher archiviert</strong> (GoBD-Snapshot,
            Object-Lock) und <strong>schreibgeschützt</strong> — Markierungen/Bewertungen lassen
            sich nicht mehr ändern. Ansicht + Export bleiben verfügbar.
          </div>
        )}

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

        {/* Flying Pill: fixed → immer sichtbar, egal ob ein Marking-Panel offen ist
          oder wie weit gescrollt wurde (auch über dem Vollbild-Dokument, z-50). */}
        {pollLlm && !llmFailed && (
          <div
            className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-2 rounded-full border border-purple-300 dark:border-purple-700 bg-purple-50/95 dark:bg-purple-900/90 px-4 py-2 text-sm text-purple-800 dark:text-purple-100 shadow-lg backdrop-blur"
            role="status"
            aria-live="polite"
            title="Die neuen Markierungen erscheinen automatisch, sobald der Lauf fertig ist. Du kannst weiterarbeiten."
          >
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            <span>
              <strong>KI-Vertiefung läuft …</strong>{' '}
              <span className="font-normal text-purple-600 dark:text-purple-300">
                ~15–30 s, im Hintergrund
              </span>
            </span>
          </div>
        )}
        {llmFailed && (
          <div className="alert-error-sm flex items-start justify-between gap-3">
            <span className="inline-flex items-start gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                <strong>KI-Vertiefung fehlgeschlagen.</strong> {llmFailed}
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setLlmFailed(null);
                  requestLlm();
                }}
                disabled={pending || !engineConfigured || !!initial.archivedAt || pollLlm}
                className="btn-secondary text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Erneut versuchen
              </button>
              <button
                type="button"
                onClick={() => setLlmFailed(null)}
                className="text-disabled hover:text-secondary"
                title="Schließen"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        )}

        <div
          className={
            expanded
              ? 'fixed inset-0 z-40 overflow-auto bg-surface-page p-4 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4'
              : 'grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4'
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
            {manualSel && canWrite ? (
              <NewMarkingPanel
                clientId={clientId}
                analysisId={initial.id}
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
                analysisId={initial.id}
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
              <LlmDeepeningCard status={llm} />
            ) : (
              <div className="card p-4 text-sm text-muted">
                <strong>Klicken</strong> Sie eine Markierung im Text an, um sie zu bewerten, zu
                delegieren oder zu definieren — oder <strong>ziehen</strong> Sie über eine Stelle,
                um eine eigene Markierung zu setzen.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
