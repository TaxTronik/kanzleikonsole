'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, Wand2, Upload, Loader2, Trash2, Send, BookPlus, Save, Plus, X,
} from 'lucide-react';
import {
  analyzeAction, requestLlmAction, addManualMarkingAction, updateMarkingAction,
  deleteMarkingAction, delegateAction, pushDefinitionAction, importDocTextAction,
} from './actions';

// --- Typen (serialisiert von der Server-Component) ---------------------------

export interface MarkingDTO {
  id: string;
  start: number;
  end: number;
  matchedText: string;
  herkunft: 'WOERTLICH' | 'MUSTER' | 'TRIGGER' | 'EMBEDDING' | 'LLM' | 'BERATER';
  begriffId: string | null;
  begriff: string;
  normAnker: string[];
  normketten: unknown;
  governanceTyp: 'FP' | 'FF' | 'IN' | null;
  schadensintensitaet: 'NIEDRIG' | 'MITTEL' | 'HOCH' | null;
  wahrscheinlichkeit: 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG' | null;
  kaskadenreichweite: number | null;
  kontrolle: string | null;
  status: 'OFFEN' | 'IN_PRUEFUNG' | 'KONTROLLIERT' | 'AKZEPTIERT';
  notiz: string | null;
  verantwortlichId: string | null;
}

export interface AnalysisDTO {
  id: string;
  sourceText: string;
  title: string | null;
  llmEnrichedAt: string | null;
  markings: MarkingDTO[];
}

interface Props {
  clientId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  initial: AnalysisDTO | null;
}

// --- Label-/Farb-Maps --------------------------------------------------------

const HERKUNFT_LABEL: Record<MarkingDTO['herkunft'], string> = {
  WOERTLICH: 'Wörtlich', MUSTER: 'Muster', TRIGGER: 'Trigger',
  EMBEDDING: 'Semantisch', LLM: 'KI', BERATER: 'Berater',
};
const STATUS_LABEL: Record<MarkingDTO['status'], string> = {
  OFFEN: 'Offen', IN_PRUEFUNG: 'In Prüfung', KONTROLLIERT: 'Kontrolliert', AKZEPTIERT: 'Akzeptiert',
};
const GOV_LABEL: Record<'FP' | 'FF' | 'IN', string> = {
  FP: 'Festsetzung (FP)', FF: 'Feststellung (FF)', IN: 'Information (IN)',
};

function markClass(m: MarkingDTO): string {
  if (m.status === 'KONTROLLIERT' || m.status === 'AKZEPTIERT')
    return 'bg-emerald-100 dark:bg-emerald-900/40 border-b-2 border-emerald-400';
  if (m.herkunft === 'BERATER') return 'bg-sky-100 dark:bg-sky-900/40 border-b-2 border-sky-400';
  if (m.herkunft === 'LLM' || m.herkunft === 'EMBEDDING')
    return 'bg-purple-100 dark:bg-purple-900/40 border-b-2 border-purple-400';
  return 'bg-amber-100 dark:bg-amber-900/40 border-b-2 border-amber-400';
}

// --- Segmentierung: Text + Markierungen → klickbare Spans ---------------------

interface Segment { text: string; marking: MarkingDTO | null; }

function buildSegments(text: string, markings: MarkingDTO[]): Segment[] {
  if (markings.length === 0) return [{ text, marking: null }];
  const bounds = new Set<number>([0, text.length]);
  for (const m of markings) {
    bounds.add(Math.max(0, Math.min(text.length, m.start)));
    bounds.add(Math.max(0, Math.min(text.length, m.end)));
  }
  const points = [...bounds].sort((a, b) => a - b);
  const segs: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!;
    if (b <= a) continue;
    // Kleinste (spezifischste) überdeckende Markierung gewinnt.
    let top: MarkingDTO | null = null;
    for (const m of markings) {
      if (m.start <= a && m.end >= b) {
        if (!top || m.end - m.start < top.end - top.start) top = m;
      }
    }
    segs.push({ text: text.slice(a, b), marking: top });
  }
  return segs;
}

// =============================================================================

export function SubsumtionWorkspace({ clientId, staffOptions, engineConfigured, initial }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Compose-Modus (neue Subsumtion)
  const [text, setText] = useState(initial?.sourceText ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const fileRef = useRef<HTMLInputElement>(null);

  // Review-Modus
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  const markings = initial?.markings ?? [];
  const segments = useMemo(
    () => (initial ? buildSegments(initial.sourceText, markings) : []),
    [initial, markings],
  );
  const selected = markings.find((m) => m.id === selectedId) ?? null;

  function flash(r: { ok: boolean; error?: string }, okMsg?: string) {
    if (!r.ok) { setError(r.error ?? 'Fehler.'); setInfo(null); }
    else { setInfo(okMsg ?? null); setError(null); }
  }

  // --- Compose-Aktionen ---
  function analyze() {
    setError(null); setInfo(null);
    start(async () => {
      const r = await analyzeAction({ clientId, text, title: title.trim() || undefined });
      if (!r.ok) { setError(r.error); return; }
      router.push(`/staff/clients/${clientId}/subsumtion/${r.analysisId}`);
    });
  }

  function onPickFile() { fileRef.current?.click(); }
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
      setInfo('Text aus Dokument übernommen.');
    });
  }

  // --- Review-Aktionen ---
  function refresh() { router.refresh(); }

  function requestLlm() {
    if (!initial) return;
    setError(null);
    start(async () => {
      const r = await requestLlmAction({ clientId, analysisId: initial.id, sourceText: initial.sourceText });
      flash(r, 'KI-Vertiefung gestartet — Markierungen erscheinen in Kürze (Seite neu laden).');
    });
  }

  function addManual() {
    if (!initial) return;
    const ta = sourceRef.current;
    if (!ta) return;
    const s = ta.selectionStart, en = ta.selectionEnd;
    if (en <= s) { setError('Bitte zuerst eine Textstelle markieren.'); return; }
    const matchedText = initial.sourceText.slice(s, en);
    const begriff = window.prompt('Begriff für diese Markierung:', matchedText.slice(0, 60));
    if (!begriff || !begriff.trim()) return;
    setError(null);
    start(async () => {
      const r = await addManualMarkingAction({
        clientId, analysisId: initial.id, start: s, end: en, matchedText, begriff: begriff.trim(),
      });
      flash(r, 'Markierung hinzugefügt.');
      if (r.ok) { setManualMode(false); refresh(); }
    });
  }

  // ---------------------------------------------------------------------------
  // COMPOSE-MODUS
  // ---------------------------------------------------------------------------
  if (!initial) {
    return (
      <div className="space-y-3">
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
          placeholder="Bezeichnung (optional), z. B. „Kassenführung 2024“"
          className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Sachverhalt hier eingeben oder aus einem Dokument importieren …"
          rows={18}
          className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm font-mono leading-relaxed"
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={analyze} disabled={pending || !engineConfigured || !text.trim()} className="btn-primary text-sm">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Analysieren
          </button>
          <button type="button" onClick={onPickFile} disabled={pending} className="btn-secondary text-sm">
            <Upload className="h-4 w-4" />
            Aus Dokument importieren
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={onFile} className="hidden" />
          <span className="text-xs text-muted ml-auto">{text.length} Zeichen</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // REVIEW-MODUS
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="badge-gray text-xs">{markings.length} Markierungen</span>
        {initial.llmEnrichedAt ? (
          <span className="badge-purple text-xs">KI-vertieft</span>
        ) : (
          <button type="button" onClick={requestLlm} disabled={pending || !engineConfigured} className="btn-secondary text-xs">
            <Wand2 className="h-3.5 w-3.5" />
            Mit KI vertiefen
          </button>
        )}
        <button type="button" onClick={() => setManualMode((v) => !v)} className="btn-secondary text-xs">
          <Plus className="h-3.5 w-3.5" />
          {manualMode ? 'Fertig markieren' : 'Manuell markieren'}
        </button>
        <a href={`/staff/clients/${clientId}/subsumtion/new`} className="btn-secondary text-xs ml-auto">
          Neue Subsumtion
        </a>
      </div>

      {error && <div className="alert-error-sm">{error}</div>}
      {info && <div className="text-sm text-emerald-700 dark:text-emerald-300">{info}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        {/* Text + Highlights ODER Manuell-Markieren */}
        <div className="card p-4">
          {manualMode ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Textstelle markieren und „Stelle hinzufügen“ klicken — sie wird als Berater-Markierung gespeichert.
              </p>
              <textarea
                ref={sourceRef}
                readOnly
                defaultValue={initial.sourceText}
                rows={18}
                className="w-full rounded-md border border-default bg-surface px-3 py-2 text-sm font-mono leading-relaxed"
              />
              <button type="button" onClick={addManual} disabled={pending} className="btn-primary text-xs">
                <Plus className="h-3.5 w-3.5" /> Stelle hinzufügen
              </button>
            </div>
          ) : (
            <div className="whitespace-pre-wrap text-sm leading-relaxed font-mono">
              {segments.map((seg, i) =>
                seg.marking ? (
                  <mark
                    key={i}
                    onClick={() => setSelectedId(seg.marking!.id)}
                    className={
                      'cursor-pointer rounded-sm px-0.5 ' +
                      markClass(seg.marking) +
                      (seg.marking.id === selectedId ? ' ring-2 ring-brand-500' : '')
                    }
                    title={seg.marking.begriff}
                  >
                    {seg.text}
                  </mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </div>
          )}
        </div>

        {/* Marking-Panel */}
        <div>
          {selected ? (
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
              setError={setError}
              setInfo={setInfo}
            />
          ) : (
            <div className="card p-4 text-sm text-muted">
              Eine Markierung im Text anklicken, um sie zu bewerten, zu delegieren oder zu definieren.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Marking-Panel
// =============================================================================

function MarkingPanel(props: {
  clientId: string;
  analysisId: string;
  marking: MarkingDTO;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onChanged: () => void;
  onClose: () => void;
  setError: (s: string | null) => void;
  setInfo: (s: string | null) => void;
}) {
  const { clientId, analysisId, marking: m, staffOptions, engineConfigured, pending, start, onChanged, onClose, setError, setInfo } = props;

  const [gov, setGov] = useState(m.governanceTyp ?? '');
  const [intens, setIntens] = useState(m.schadensintensitaet ?? '');
  const [wk, setWk] = useState(m.wahrscheinlichkeit ?? '');
  const [kask, setKask] = useState(m.kaskadenreichweite?.toString() ?? '');
  const [kontrolle, setKontrolle] = useState(m.kontrolle ?? '');
  const [status, setStatus] = useState(m.status);
  const [notiz, setNotiz] = useState(m.notiz ?? '');
  const [verantw, setVerantw] = useState(m.verantwortlichId ?? '');

  const [showDelegate, setShowDelegate] = useState(false);
  const [showDefine, setShowDefine] = useState(false);

  function flash(r: { ok: boolean; error?: string }, ok?: string) {
    if (!r.ok) { setError(r.error ?? 'Fehler.'); setInfo(null); } else { setInfo(ok ?? null); setError(null); }
  }

  function save() {
    setError(null);
    start(async () => {
      const r = await updateMarkingAction({
        clientId, analysisId, markingId: m.id,
        governanceTyp: (gov || null) as 'FP' | 'FF' | 'IN' | null,
        schadensintensitaet: (intens || null) as 'NIEDRIG' | 'MITTEL' | 'HOCH' | null,
        wahrscheinlichkeit: (wk || null) as never,
        kaskadenreichweite: kask.trim() === '' ? null : Number(kask),
        kontrolle: kontrolle.trim() || null,
        status,
        notiz: notiz.trim() || null,
        verantwortlichId: verantw || null,
      });
      flash(r, 'Gespeichert.');
      if (r.ok) onChanged();
    });
  }

  function remove() {
    if (!window.confirm('Markierung löschen?')) return;
    setError(null);
    start(async () => {
      const r = await deleteMarkingAction({ clientId, analysisId, markingId: m.id });
      flash(r, 'Gelöscht.');
      if (r.ok) { onClose(); onChanged(); }
    });
  }

  return (
    <div className="card p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-primary">{m.begriff}</p>
          <p className="text-xs text-muted">
            <span className="badge-gray text-[10px] mr-1">{HERKUNFT_LABEL[m.herkunft]}</span>
            Zeichen {m.start}–{m.end}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-disabled hover:text-secondary"><X className="h-4 w-4" /></button>
      </div>

      {m.normAnker.length > 0 && (
        <p className="text-xs text-secondary"><span className="text-muted">Normanker:</span> {m.normAnker.join(', ')}</p>
      )}
      {m.normketten != null && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Normketten</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[11px]">
            {JSON.stringify(m.normketten, null, 2)}
          </pre>
        </details>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Select label="Governance" value={gov} onChange={setGov} options={[['', '—'], ['FP', GOV_LABEL.FP], ['FF', GOV_LABEL.FF], ['IN', GOV_LABEL.IN]]} />
        <Select label="Status" value={status} onChange={(v) => setStatus(v as MarkingDTO['status'])} options={(['OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT'] as const).map((s) => [s, STATUS_LABEL[s]])} />
        <Select label="Schadensintensität" value={intens} onChange={setIntens} options={[['', '—'], ['NIEDRIG', 'Niedrig'], ['MITTEL', 'Mittel'], ['HOCH', 'Hoch']]} />
        <Select label="Wahrscheinlichkeit" value={wk} onChange={setWk} options={[['', '—'], ['SELTEN', 'Selten'], ['MOEGLICH', 'Möglich'], ['WAHRSCHEINLICH', 'Wahrscheinlich'], ['HAEUFIG', 'Häufig']]} />
        <label className="text-xs">
          <span className="text-muted">Kaskadenreichweite</span>
          <input type="number" min={0} max={99} value={kask} onChange={(e) => setKask(e.target.value)} className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
        </label>
        <Select label="Verantwortlich" value={verantw} onChange={setVerantw} options={[['', '—'], ...staffOptions.map((s) => [s.id, s.fullName] as [string, string])]} />
      </div>

      <label className="block text-xs">
        <span className="text-muted">Kontrolle / Maßnahme</span>
        <textarea value={kontrolle} onChange={(e) => setKontrolle(e.target.value)} rows={2} className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>
      <label className="block text-xs">
        <span className="text-muted">Notiz</span>
        <textarea value={notiz} onChange={(e) => setNotiz(e.target.value)} rows={2} className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={pending} className="btn-primary text-xs"><Save className="h-3.5 w-3.5" /> Speichern</button>
        <button type="button" onClick={() => setShowDelegate((v) => !v)} className="btn-secondary text-xs"><Send className="h-3.5 w-3.5" /> Delegieren</button>
        <button type="button" onClick={() => setShowDefine((v) => !v)} disabled={!engineConfigured} className="btn-secondary text-xs"><BookPlus className="h-3.5 w-3.5" /> Definieren</button>
        <button type="button" onClick={remove} disabled={pending} className="text-red-700 hover:text-red-800 text-xs inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /> Löschen</button>
      </div>

      {showDelegate && (
        <DelegateForm clientId={clientId} analysisId={analysisId} markingId={m.id} staffOptions={staffOptions} pending={pending} start={start} onDone={(r) => { flash(r, 'Recherche delegiert — Wiedervorlage angelegt.'); if (r.ok) { setShowDelegate(false); onChanged(); } }} />
      )}
      {showDefine && (
        <DefineForm clientId={clientId} analysisId={analysisId} markingId={m.id} begriff={m.begriff} normAnker={m.normAnker} pending={pending} start={start} onDone={(r) => { flash(r, 'Definition an den Katalog übergeben.'); if (r.ok) { setShowDefine(false); onChanged(); } }} />
      )}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="text-xs">
      <span className="text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function DelegateForm(props: {
  clientId: string; analysisId: string; markingId: string;
  staffOptions: Array<{ id: string; fullName: string }>;
  pending: boolean; start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
}) {
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  function submit() {
    if (!assignee) { props.onDone({ ok: false, error: 'Bitte einen Mitarbeiter wählen.' }); return; }
    props.start(async () => {
      const r = await delegateAction({ clientId: props.clientId, analysisId: props.analysisId, markingId: props.markingId, assigneeStaffId: assignee, dueDate: due || undefined, notes: notes || undefined });
      props.onDone(r);
    });
  }
  return (
    <div className="rounded-md border border-default p-2 space-y-2 bg-gray-50/50 dark:bg-gray-900/30">
      <p className="text-xs font-medium text-secondary">Recherche delegieren (Wiedervorlage)</p>
      <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-full rounded border border-default bg-surface px-2 py-1 text-xs">
        <option value="">Mitarbeiter wählen …</option>
        {props.staffOptions.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
      </select>
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-full rounded border border-default bg-surface px-2 py-1 text-xs" />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Zusatz (optional)" className="w-full rounded border border-default bg-surface px-2 py-1 text-xs" />
      <button type="button" onClick={submit} disabled={props.pending} className="btn-primary text-xs w-full justify-center"><Send className="h-3.5 w-3.5" /> Delegieren</button>
    </div>
  );
}

function DefineForm(props: {
  clientId: string; analysisId: string; markingId: string; begriff: string; normAnker: string[];
  pending: boolean; start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
}) {
  const [begriff, setBegriff] = useState(props.begriff);
  const [definition, setDefinition] = useState('');
  function submit() {
    if (!definition.trim()) { props.onDone({ ok: false, error: 'Bitte eine Definition eingeben.' }); return; }
    props.start(async () => {
      const r = await pushDefinitionAction({ clientId: props.clientId, analysisId: props.analysisId, markingId: props.markingId, begriff: begriff.trim(), definition: definition.trim(), normAnker: props.normAnker });
      props.onDone(r);
    });
  }
  return (
    <div className="rounded-md border border-default p-2 space-y-2 bg-gray-50/50 dark:bg-gray-900/30">
      <p className="text-xs font-medium text-secondary">Begriff in den Katalog definieren</p>
      <input value={begriff} onChange={(e) => setBegriff(e.target.value)} className="w-full rounded border border-default bg-surface px-2 py-1 text-xs" />
      <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} rows={3} placeholder="Definition / Subsumtion …" className="w-full rounded border border-default bg-surface px-2 py-1 text-xs" />
      <button type="button" onClick={submit} disabled={props.pending} className="btn-primary text-xs w-full justify-center"><BookPlus className="h-3.5 w-3.5" /> An Katalog senden</button>
    </div>
  );
}
