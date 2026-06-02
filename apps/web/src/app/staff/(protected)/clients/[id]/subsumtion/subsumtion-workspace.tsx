'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Upload, Loader2, FileDown, FolderOpen, ClipboardList, ScrollText, Webhook, FileText, FileType, Archive, Lock } from 'lucide-react';
import { analyzeAction, importDocTextAction, importClientDocAction, requestLlmAction, archiveAnalysisAction } from './actions';
import { DisclaimerBanner } from './disclaimer-banner';
import { StatsBar } from './stats-bar';
import { HerkunftLegende } from './herkunft-legende';
import { AnnotatedDocument } from './annotated-document';
import { MarkingPanel, ResearchComposer } from './marking-panel';
import { NewMarkingPanel } from './new-marking-panel';
import { ResearchResultsBlock } from './research-results-block';
import { type AnalysisDTO, type ResearchResultDTO, type MarkingDTO, FILTER_KEYS, type FilterKey, isVisible } from './_ui';

interface Props {
  clientId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  clientDocuments: Array<{ id: string; title: string; mimeType: string; typeName: string }>;
  researchResults?: ResearchResultDTO[];
  engineConfigured: boolean;
  initial: AnalysisDTO | null;
}

export function SubsumtionWorkspace({ clientId, staffOptions, clientDocuments, researchResults = [], engineConfigured, initial }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Compose-Modus
  const [text, setText] = useState(initial?.sourceText ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [docId, setDocId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Review-Modus
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [filters, setFilters] = useState<Set<FilterKey>>(() => new Set(FILTER_KEYS));
  const [manualSel, setManualSel] = useState<{ start: number; end: number; text: string } | null>(null);
  const [showCaseResearch, setShowCaseResearch] = useState(false);

  const markings = initial?.markings ?? [];
  const visibleMarkings = useMemo(() => markings.filter((m) => isVisible(m, filters)), [markings, filters]);
  const selected = markings.find((m) => m.id === selectedId) ?? null;
  const ownCount = markings.filter((m) => m.herkunft === 'BERATER').length;
  const markingsById = useMemo(
    () => Object.fromEntries(markings.map((m) => [m.id, m])) as Record<string, MarkingDTO>,
    [markings],
  );

  function flash(r: { ok: boolean; error?: string }, okMsg?: string) {
    if (!r.ok) { setError(r.error ?? 'Fehler.'); setInfo(null); }
    else { setInfo(okMsg ?? null); setError(null); }
  }
  function refresh() { router.refresh(); }

  // --- Compose-Aktionen ---
  function analyze() {
    setError(null); setInfo(null);
    start(async () => {
      const r = await analyzeAction({ clientId, text, title: title.trim() || undefined });
      if (!r.ok) { setError(r.error); return; }
      router.push(`/staff/clients/${clientId}/subsumtion/${r.analysisId}`);
    });
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null); setInfo(null);
    start(async () => {
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('file', file);
      const r = await importDocTextAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setText((prev) => (prev.trim() ? prev + '\n\n' + r.text : r.text));
      // Titel-Vorschlag nur übernehmen, wenn noch keiner gesetzt ist.
      if (r.suggestedTitle && !title.trim()) setTitle(r.suggestedTitle);
      setInfo('Text aus Dokument übernommen.');
    });
  }
  function importExisting() {
    if (!docId) return;
    setError(null); setInfo(null);
    start(async () => {
      const r = await importClientDocAction({ clientId, documentId: docId });
      if (!r.ok) { setError(r.error); return; }
      setText((prev) => (prev.trim() ? prev + '\n\n' + r.text : r.text));
      if (r.suggestedTitle && !title.trim()) setTitle(r.suggestedTitle);
      setInfo('Text aus Mandanten-Dokument übernommen.');
    });
  }

  // --- Review-Aktionen ---
  function requestLlm() {
    if (!initial) return;
    setError(null);
    start(async () => {
      const r = await requestLlmAction({ clientId, analysisId: initial.id });
      flash(r, 'KI-Vertiefung gestartet — Markierungen erscheinen in Kürze (Seite neu laden).');
    });
  }
  function toggleFilter(k: FilterKey) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  function archive() {
    if (!initial) return;
    if (!window.confirm('Subsumtion revisionssicher archivieren? Danach ist sie schreibgeschützt (GoBD-Snapshot, Object-Lock).')) return;
    setError(null);
    start(async () => {
      const r = await archiveAnalysisAction({ clientId, analysisId: initial.id });
      flash(r, 'Subsumtion revisionssicher archiviert (schreibgeschützt).');
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
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Sachverhalt hier eingeben oder aus einem Dokument importieren …"
          rows={18}
          className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm font-mono leading-relaxed"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={analyze} disabled={pending || !engineConfigured || !text.trim()} className="btn-primary text-sm">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Analysieren
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={pending} className="btn-secondary text-sm">
            <Upload className="h-4 w-4" />
            Aus Dokument importieren
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={onFile} className="hidden" />
          <span className="text-xs text-muted ml-auto">{text.length} Zeichen</span>
        </div>
        {clientDocuments.length > 0 && (
          <div className="flex items-center gap-2">
            <select value={docId} onChange={(e) => setDocId(e.target.value)} className="rounded-md border border-default bg-surface px-2 py-1.5 text-sm max-w-[60%] truncate">
              <option value="">Aus Mandanten-Dokument (SeaweedFS) wählen …</option>
              {clientDocuments.map((d) => (
                <option key={d.id} value={d.id}>{d.title}{d.typeName ? ` (${d.typeName})` : ''}</option>
              ))}
            </select>
            <button type="button" onClick={importExisting} disabled={pending || !docId} className="btn-secondary text-sm">
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
      />

      {/* Toolbar — bestehende TaxTronik-Features verlinkt */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/staff/clients/${clientId}/subsumtion/new`} className="btn-secondary text-xs">‹ Neue Analyse</Link>
        <Link href={`/staff/clients/${clientId}`} className="btn-secondary text-xs"><FolderOpen className="h-3.5 w-3.5" /> Aktenregal</Link>
        <Link href={`/staff/clients/${clientId}/reminders`} className="btn-secondary text-xs"><ClipboardList className="h-3.5 w-3.5" /> Aufgaben</Link>
        <Link href={`/staff/clients/${clientId}/timeline`} className="btn-secondary text-xs"><ScrollText className="h-3.5 w-3.5" /> Audit-Log</Link>
        <a href={`/api/staff/clients/${clientId}/subsumtion/${initial.id}/export?format=docx`} className="btn-secondary text-xs" title="Als Word-Dokument exportieren">
          <FileText className="h-3.5 w-3.5" /> DOCX
        </a>
        <a href={`/api/staff/clients/${clientId}/subsumtion/${initial.id}/export?format=pdf`} className="btn-secondary text-xs" title="Als PDF exportieren">
          <FileType className="h-3.5 w-3.5" /> PDF
        </a>
        {initial.archivedAt ? (
          <span className="badge-gray text-xs inline-flex items-center gap-1 ml-auto" title="Revisionssicher archiviert (Object-Lock)">
            <Lock className="h-3.5 w-3.5" /> Archiviert {new Date(initial.archivedAt).toLocaleDateString('de-DE')}
          </span>
        ) : (
          <>
            <button type="button" onClick={archive} disabled={pending} className="btn-secondary text-xs ml-auto" title="Revisionssicher archivieren (GoBD, schreibgeschützt)">
              <Archive className="h-3.5 w-3.5" /> Archivieren
            </button>
            <button type="button" onClick={() => setShowCaseResearch((v) => !v)} className="btn-secondary text-xs">
              <Webhook className="h-3.5 w-3.5" /> Ganzer Fall an KI
            </button>
          </>
        )}
      </div>

      {initial.archivedAt && (
        <div className="rounded-md border border-default bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-secondary inline-flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-disabled shrink-0" />
          Diese Subsumtion ist <strong>revisionssicher archiviert</strong> (GoBD-Snapshot, Object-Lock) und <strong>schreibgeschützt</strong> — Markierungen/Bewertungen lassen sich nicht mehr ändern. Ansicht + Export bleiben verfügbar.
        </div>
      )}

      {showCaseResearch && (
        <div className="max-w-xl">
          <ResearchComposer
            clientId={clientId}
            analysisId={initial.id}
            markingId={null}
            pending={pending}
            start={start}
            onDone={(r) => { flash(r, 'Anonymisierter Auftrag (ganzer Fall) an n8n gesendet.'); if (r.ok) setShowCaseResearch(false); }}
          />
        </div>
      )}

      <HerkunftLegende />

      {error && <div className="alert-error-sm">{error}</div>}
      {info && <div className="text-sm text-emerald-700 dark:text-emerald-300">{info}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        <AnnotatedDocument
          sourceText={initial.sourceText}
          totalCount={markings.length}
          ownCount={ownCount}
          textHash={initial.textHash}
          visibleMarkings={visibleMarkings}
          filters={filters}
          onToggleFilter={toggleFilter}
          editMode={editMode}
          onToggleEdit={() => setEditMode((v) => !v)}
          selectedId={selectedId}
          onSelectMarking={(id) => { setSelectedId(id); setEditMode(false); }}
          onManualSelect={setManualSel}
        />

        {/* Sticky: Panel bleibt beim Scrollen sichtbar — Klick auf eine Markierung
            weit unten muss nicht zurück nach oben gescrollt werden. self-start
            verhindert das Grid-Stretching (sonst greift sticky nicht); bei langem
            Panel scrollt es intern. */}
        <div className="lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {editMode ? (
            <NewMarkingPanel
              clientId={clientId}
              analysisId={initial.id}
              selection={manualSel}
              pending={pending}
              start={start}
              onDone={(r) => { flash(r, 'Markierung hinzugefügt.'); if (r.ok) { setManualSel(null); refresh(); } }}
            />
          ) : selected ? (
            <MarkingPanel
              key={selected.id}
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
          ) : (
            <div className="card p-4 text-sm text-muted">
              Eine Markierung im Text anklicken, um sie zu bewerten, zu delegieren oder zu definieren.
              Oder den <strong>Edit-Modus</strong> aktivieren, um eigene Stellen zu markieren.
            </div>
          )}
        </div>
      </div>

      <ResearchResultsBlock
        clientId={clientId}
        analysisId={initial.id}
        results={researchResults}
        markingsById={markingsById}
        pending={pending}
        start={start}
        onFlash={flash}
      />
    </div>
  );
}
