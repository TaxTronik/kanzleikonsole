'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Save, Send, BookPlus, BookmarkPlus, Trash2, AlertTriangle, Webhook, Eye, Loader2, ChevronRight, Scale, Search, Undo2 } from 'lucide-react';
import {
  updateMarkingAction, deleteMarkingAction, delegateAction, pushDefinitionAction,
  previewResearchAction, sendResearchAction, resolveNormAction,
  searchNormAction, addBeraterNormAction, setNormVerworfenAction, removeBeraterNormAction,
  listPromptTemplatesAction, createPromptTemplateAction, deletePromptTemplateAction,
} from './actions';
import {
  type MarkingDTO, type NormRefDTO, GOV_LABEL, STATUS_LABEL, HERKUNFT_LABEL, ENGINE_STATUS_LABEL, herkunftBadge,
} from './_ui';
import type { ResolvedNorm, NormHit, PromptTemplateDTO } from '@/server/risk';

type Flash = (r: { ok: boolean; error?: string }, ok?: string) => void;

/** Modal-A11y: Esc schließt, Tab bleibt im Dialog gefangen, Initial-Fokus aufs
 *  erste Element, beim Schließen kehrt der Fokus zum Auslöser zurück. */
function useDialogA11y(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () =>
      node
        ? Array.from(
            node.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
    };
  }, []);
  return ref;
}

export function MarkingPanel(props: {
  clientId: string;
  analysisId: string;
  marking: MarkingDTO;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onChanged: () => void;
  onClose: () => void;
  flash: Flash;
}) {
  const { clientId, analysisId, marking: m, staffOptions, engineConfigured, pending, start, onChanged, onClose, flash } = props;

  // Tatsächlich markierter Text (Fundstelle) — Whitespace geglättet, gekappt.
  // Nur zeigen, wenn er sich vom Begriff unterscheidet (sonst redundant, z. B. wörtlich).
  const fundstelle = m.matchedText.replace(/\s+/g, ' ').trim();
  const showFundstelle = fundstelle.length > 0 && fundstelle !== m.begriff.trim();
  const fundstelleShort = fundstelle.length > 220 ? fundstelle.slice(0, 220) + '…' : fundstelle;

  const [gov, setGov] = useState(m.governanceTyp ?? '');
  const [intens, setIntens] = useState(m.schadensintensitaet ?? '');
  const [wk, setWk] = useState(m.wahrscheinlichkeit ?? '');
  const [kask, setKask] = useState(m.kaskadenreichweite?.toString() ?? '');
  const [kontrolle, setKontrolle] = useState(m.kontrolle ?? '');
  const [status, setStatus] = useState(m.status);
  const [notiz, setNotiz] = useState(m.notiz ?? '');
  const [verantw, setVerantw] = useState(m.verantwortlichId ?? '');
  const [label, setLabel] = useState(m.label ?? '');

  const [showDelegate, setShowDelegate] = useState(false);
  const [showDefine, setShowDefine] = useState(false);
  const [showResearch, setShowResearch] = useState(false);

  function save() {
    start(async () => {
      const r = await updateMarkingAction({
        clientId, analysisId, markingId: m.id,
        governanceTyp: (gov || null) as 'FP' | 'FF' | 'IN' | null,
        schadensintensitaet: (intens || null) as 'NIEDRIG' | 'MITTEL' | 'HOCH' | null,
        wahrscheinlichkeit: (wk || null) as 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG' | null,
        kaskadenreichweite: kask.trim() === '' ? null : Number(kask),
        kontrolle: kontrolle.trim() || null,
        status,
        notiz: notiz.trim() || null,
        verantwortlichId: verantw || null,
        label: label.trim() || null,
      });
      flash(r, 'Gespeichert.');
      if (r.ok) onChanged();
    });
  }

  function remove() {
    if (!window.confirm('Markierung löschen?')) return;
    start(async () => {
      const r = await deleteMarkingAction({ clientId, analysisId, markingId: m.id });
      flash(r, 'Gelöscht.');
      if (r.ok) { onClose(); onChanged(); }
    });
  }

  return (
    <div className="card p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-primary break-words">{m.begriff}</p>
          {showFundstelle && (
            <p className="text-xs text-secondary mt-1 break-words" title={fundstelle.length > 220 ? fundstelle : undefined}>
              <span className="text-muted">markiert: </span>
              <span className="italic">„{fundstelleShort}"</span>
            </p>
          )}
          <p className="text-xs text-muted mt-1 flex items-center gap-1 flex-wrap">
            <span className={herkunftBadge(m.herkunft) + ' text-[10px]'}>{HERKUNFT_LABEL[m.herkunft]}</span>
            {m.engineStatus && <span className="badge-gray text-[10px]">{ENGINE_STATUS_LABEL[m.engineStatus] ?? m.engineStatus}</span>}
            <span>Zeichen {m.start}–{m.end}</span>
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-disabled hover:text-secondary shrink-0"><X className="h-4 w-4" /></button>
      </div>

      {m.streitig && (
        <p className="text-xs text-red-700 dark:text-red-300 inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" /> Fachlich umstrittene Stelle (Streit).
        </p>
      )}
      <NormRefList clientId={clientId} markingId={m.id} refs={m.normRefs} fallback={m.normAnker}
        pending={pending} start={start} flash={flash} onChanged={onChanged} />
      {m.normketten != null && Array.isArray(m.normketten) && m.normketten.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Normketten (Kaskade)</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[11px] whitespace-pre-wrap">
            {JSON.stringify(m.normketten, null, 2)}
          </pre>
        </details>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Select label="Governance" value={gov} onChange={setGov} options={[['', '—'], ['FP', GOV_LABEL.FP], ['FF', GOV_LABEL.FF], ['IN', GOV_LABEL.IN]]} />
        <Select label="Prüf-Status" value={status} onChange={(v) => setStatus(v as MarkingDTO['status'])} options={(['OFFEN', 'IN_PRUEFUNG', 'KONTROLLIERT', 'AKZEPTIERT'] as const).map((s) => [s, STATUS_LABEL[s]])} />
        <Select label="Schadensintensität" value={intens} onChange={setIntens} options={[['', '—'], ['NIEDRIG', 'Niedrig'], ['MITTEL', 'Mittel'], ['HOCH', 'Hoch']]} />
        <Select label="Wahrscheinlichkeit" value={wk} onChange={setWk} options={[['', '—'], ['SELTEN', 'Selten'], ['MOEGLICH', 'Möglich'], ['WAHRSCHEINLICH', 'Wahrscheinlich'], ['HAEUFIG', 'Häufig']]} />
        <label className="text-xs">
          <span className="text-muted">Kaskadenreichweite</span>
          <input type="number" min={0} max={99} value={kask} onChange={(e) => setKask(e.target.value)} className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
        </label>
        <Select label="Verantwortlich" value={verantw} onChange={setVerantw} options={[['', '—'], ...staffOptions.map((s) => [s.id, s.fullName] as [string, string])]} />
      </div>

      <label className="block text-xs">
        <span className="text-muted">Label / Kategorie</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. kritisch, offen, Mandantenfrage" className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>
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
        <button type="button" onClick={() => setShowDelegate((v) => !v)} className="btn-secondary text-xs"><Send className="h-3.5 w-3.5" /> Zuweisen</button>
        <button type="button" onClick={() => setShowResearch((v) => !v)} className="btn-secondary text-xs"><Webhook className="h-3.5 w-3.5" /> An n8n</button>
        <button type="button" onClick={() => setShowDefine((v) => !v)} disabled={!engineConfigured} className="btn-secondary text-xs"><BookPlus className="h-3.5 w-3.5" /> Definieren</button>
        <button type="button" onClick={remove} disabled={pending} className="text-red-700 hover:text-red-800 text-xs inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /> Löschen</button>
      </div>

      {showDelegate && (
        <DelegateForm clientId={clientId} analysisId={analysisId} markingId={m.id} staffOptions={staffOptions} pending={pending} start={start}
          onDone={(r) => { flash(r, 'An Mitarbeiter zugewiesen — Wiedervorlage angelegt.'); if (r.ok) { setShowDelegate(false); onChanged(); } }} />
      )}
      {showResearch && (
        <ResearchComposer clientId={clientId} analysisId={analysisId} markingId={m.id} pending={pending} start={start}
          onClose={() => setShowResearch(false)}
          onDone={(r) => { flash(r, 'Anonymisierter Auftrag an n8n gesendet.'); if (r.ok) setShowResearch(false); }} />
      )}
      {showDefine && (
        <DefineForm clientId={clientId} analysisId={analysisId} markingId={m.id} begriff={m.begriff} normAnker={m.normAnker} pending={pending} start={start}
          onDone={(r) => { flash(r, 'Definition an den Katalog übergeben.'); if (r.ok) { setShowDefine(false); onChanged(); } }} />
      )}
    </div>
  );
}

export function ResearchComposer(props: {
  clientId: string; analysisId: string; markingId?: string | null;
  pending: boolean; start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
  onClose: () => void;
}) {
  // Markierungs-Composer: Kein / Auszug / Ganzer Sachverhalt (Default: kein).
  // Fall-Composer (ohne Markierung): Kein / Ganzer Sachverhalt (Default: ganz).
  const isCase = !props.markingId;
  const [sachverhalt, setSachverhalt] = useState<'none' | 'excerpt' | 'full'>(isCase ? 'full' : 'none');
  const [snippet, setSnippet] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<{ text: string; hits: number } | null>(null);
  const [finalText, setFinalText] = useState('');

  // Prompt-Vorlagen (kanzleiweit)
  const [templates, setTemplates] = useState<PromptTemplateDTO[]>([]);
  const [selectedTpl, setSelectedTpl] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [tplTitle, setTplTitle] = useState('');

  useEffect(() => {
    let active = true;
    listPromptTemplatesAction({ clientId: props.clientId }).then((r) => {
      if (active && r.ok) setTemplates(r.templates);
    });
    return () => { active = false; };
  }, [props.clientId]);

  // Jede Änderung der Eingaben macht eine bestehende Vorschau ungültig → schließen
  // (sonst zeigte/sendete die Box veralteten Text, z. B. den SV nach Toggle auf „nur Prompt").
  function resetPreview() { setPreview(null); setFinalText(''); }

  function applyTemplate(id: string) {
    setSelectedTpl(id);
    const t = templates.find((x) => x.id === id);
    if (t) setPrompt(t.body);
    resetPreview();
  }
  function saveTemplate() {
    if (!tplTitle.trim() || !prompt.trim()) return;
    props.start(async () => {
      const r = await createPromptTemplateAction({ clientId: props.clientId, title: tplTitle.trim(), body: prompt.trim() });
      if (!r.ok) { props.onDone(r); return; }
      setTemplates((prev) => [...prev, r.template].sort((a, b) => a.title.localeCompare(b.title)));
      setSelectedTpl(r.template.id);
      setShowSave(false); setTplTitle('');
    });
  }
  function deleteTemplate() {
    if (!selectedTpl || !window.confirm('Diese Prompt-Vorlage löschen?')) return;
    const id = selectedTpl;
    props.start(async () => {
      const r = await deletePromptTemplateAction({ clientId: props.clientId, id });
      if (!r.ok) { props.onDone(r); return; }
      setTemplates((prev) => prev.filter((x) => x.id !== id));
      setSelectedTpl('');
    });
  }

  const baseInput = () => ({
    clientId: props.clientId,
    analysisId: props.analysisId,
    markingId: props.markingId ?? null,
    sachverhalt,
    snippets: snippet.trim() ? [snippet.trim()] : [],
    prompt: prompt.trim() || null,
  });

  function doPreview() {
    props.start(async () => {
      const r = await previewResearchAction(baseInput());
      if (!r.ok) { props.onDone(r); return; }
      setPreview({ text: r.anonymizedText, hits: r.heuristicHits.length });
      setFinalText(r.anonymizedText);
    });
  }
  function doSend() {
    props.start(async () => {
      const r = await sendResearchAction({ ...baseInput(), finalText });
      props.onDone(r.ok ? { ok: true } : r);
      if (r.ok) setPreview(null);
    });
  }

  const field = 'w-full rounded border border-default bg-surface px-3 py-2 text-sm';
  const dialogRef = useDialogA11y(props.onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={props.onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isCase ? 'Ganzen Fall an n8n senden' : 'Rechercheauftrag an n8n'}
        className="relative z-10 w-full max-w-2xl max-h-[90vh] overflow-y-auto card p-5 space-y-3 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-primary inline-flex items-center gap-1">
            <Webhook className="h-4 w-4" /> {isCase ? 'Ganzen Fall an n8n/KI (anonymisiert)' : 'Rechercheauftrag an n8n (anonymisiert)'}
          </p>
          <button type="button" onClick={props.onClose} className="text-disabled hover:text-secondary" title="Schließen"><X className="h-4 w-4" /></button>
        </div>

        <label className="block text-xs">
          <span className="text-muted">Sachverhalt</span>
          <select value={sachverhalt} onChange={(e) => { setSachverhalt(e.target.value as 'none' | 'excerpt' | 'full'); resetPreview(); }} className={'mt-0.5 ' + field}>
            <option value="none">Kein Sachverhalt (nur Rechtsfrage/Prompt)</option>
            {!isCase && <option value="excerpt">Auszug um die Fundstelle</option>}
            <option value="full">Ganzer Sachverhalt</option>
          </select>
        </label>
        {sachverhalt === 'full' && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Der gesamte Sachverhalt wird anonymisiert — bitte die Vorschau besonders sorgfältig prüfen.
          </p>
        )}

        <textarea value={snippet} onChange={(e) => { setSnippet(e.target.value); resetPreview(); }} rows={3} placeholder="Textbaustein (optional)" className={field} />

        {/* Prompt-Vorlagen + Prompt */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <select value={selectedTpl} onChange={(e) => applyTemplate(e.target.value)} className={'flex-1 ' + field} title="Gespeicherte Prompt-Vorlage wählen">
              <option value="">— Prompt-Vorlage wählen —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
            {selectedTpl && (
              <button type="button" onClick={deleteTemplate} disabled={props.pending} className="text-red-600 hover:text-red-700 p-1.5" title="Gewählte Vorlage löschen"><Trash2 className="h-4 w-4" /></button>
            )}
            <button type="button" onClick={() => setShowSave((s) => !s)} disabled={!prompt.trim()} className="btn-secondary text-xs whitespace-nowrap" title="Aktuellen Prompt als kanzleiweite Vorlage speichern">
              <BookmarkPlus className="h-3.5 w-3.5" /> Als Vorlage
            </button>
          </div>
          {showSave && (
            <div className="flex items-center gap-2">
              <input value={tplTitle} onChange={(e) => setTplTitle(e.target.value)} placeholder="Titel der Vorlage (z. B. „Verrechnungspreis-Angemessenheit“)" className={'flex-1 ' + field} />
              <button type="button" onClick={saveTemplate} disabled={props.pending || !tplTitle.trim() || !prompt.trim()} className="btn-primary text-xs whitespace-nowrap"><Save className="h-3.5 w-3.5" /> Speichern</button>
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setSelectedTpl(''); resetPreview(); }}
            rows={5}
            placeholder="Prompt / Recherche-Auftrag an n8n …"
            className={field}
          />
        </div>

        {!preview ? (
          <button type="button" onClick={doPreview} disabled={props.pending} className="btn-secondary text-sm w-full justify-center">
            {props.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Anonymisierte Vorschau
          </button>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Vorschau — exakt das geht an n8n. {preview.hits > 0 ? `${preview.hits} heuristische Schwärzung(en) — bitte prüfen.` : 'Editierbar.'}
            </p>
            <textarea value={finalText} onChange={(e) => setFinalText(e.target.value)} rows={14} className={field + ' font-mono'} />
            <div className="flex gap-2">
              <button type="button" onClick={doSend} disabled={props.pending || !finalText.trim()} className="btn-primary text-sm flex-1 justify-center"><Send className="h-4 w-4" /> An n8n senden</button>
              <button type="button" onClick={() => setPreview(null)} className="btn-secondary text-sm">Zurück zum Bearbeiten</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Rechtsnormen (Gesetzestext-Expandable) ---------------------------------

/** "norm:UStG:2:abs2:nr2" → "§ 2 Abs. 2 Nr. 2 UStG" (nur Anzeige). */
function formatNormId(id: string): string {
  const parts = id.split(':');
  if (parts[0] !== 'norm' || parts.length < 3) return id;
  const law = parts[1];
  const para = parts[2];
  const rest = parts.slice(3).map((seg) => {
    const abs = /^abs(\d+[a-z]?)$/i.exec(seg);
    if (abs) return `Abs. ${abs[1]}`;
    const nr = /^nr(\d+[a-z]?)$/i.exec(seg);
    if (nr) return `Nr. ${nr[1]}`;
    const s = /^s(\d+)$/i.exec(seg);
    if (s) return `Satz ${s[1]}`;
    return seg;
  });
  return `§ ${para}${rest.length ? ' ' + rest.join(' ') : ''} ${law}`;
}

/** ISO-Datum "1976-08-31" → "31.08.1976" (ohne TZ-Verschiebung). */
function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Absatz-Marker "(1)" auf eigene Zeilen brechen — bessere Lesbarkeit. */
function formatGesetzestext(text: string): string {
  return text.replace(/\((\d+[a-z]?)\)\s*/g, '\n($1) ').trim();
}

/** Die Engine-Norm ist NICHT verbindlich: der Berater ergänzt eigene Normen und
 *  verwirft Engine-Vorschläge (soft). Effektive Liste = nicht verworfene Einträge. */
function NormRefList({
  clientId, markingId, refs, fallback, pending, start, flash, onChanged,
}: {
  clientId: string; markingId: string; refs: NormRefDTO[] | null; fallback: string[];
  pending: boolean; start: (cb: () => void) => void; flash: Flash; onChanged: () => void;
}) {
  // Strukturierte Refs sind die Quelle der Wahrheit; Altdaten/manuelle Markierungen
  // mit nur flachem normAnker werden in dieselbe Reihenfolge synthetisiert, die der
  // Server in readNormRefs erzeugt → die Indizes für verwerfen/entfernen passen.
  const list: NormRefDTO[] = refs && refs.length > 0
    ? refs
    : fallback.map((z) => ({ zitat: z, id: null, titel: null, quelle: 'ENGINE' as const, verworfen: false }));
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted inline-flex items-center gap-1">
        <Scale className="h-3 w-3" /> Rechtsnormen <span className="text-disabled">· Vorschläge, nicht verbindlich</span>
      </p>
      {list.length > 0 && (
        <ul className="space-y-1">
          {list.map((r, i) => (
            <NormRefRow key={(r.id ?? r.zitat) + ':' + i} clientId={clientId} markingId={markingId} index={i}
              refItem={r} pending={pending} start={start} flash={flash} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {showAdd ? (
        <AddNormForm clientId={clientId} markingId={markingId} pending={pending} start={start} flash={flash}
          onDone={() => { setShowAdd(false); onChanged(); }} onCancel={() => setShowAdd(false)} />
      ) : (
        <button type="button" onClick={() => setShowAdd(true)} disabled={pending}
          className="text-xs text-brand inline-flex items-center gap-1 hover:underline">
          <BookPlus className="h-3.5 w-3.5" /> Eigene Norm ergänzen
        </button>
      )}
    </div>
  );
}

function NormRefRow({
  clientId, markingId, index, refItem, pending, start, flash, onChanged,
}: {
  clientId: string; markingId: string; index: number; refItem: NormRefDTO;
  pending: boolean; start: (cb: () => void) => void; flash: Flash; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [norm, setNorm] = useState<ResolvedNorm | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canResolve = !!refItem.id;
  const isBerater = refItem.quelle === 'BERATER';
  const verworfen = refItem.verworfen === true;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && canResolve && !norm && !loading) {
      setLoading(true); setErr(null);
      resolveNormAction({ clientId, normId: refItem.id! })
        .then((r) => { if (r.ok) setNorm(r.norm); else setErr(r.error); })
        .catch(() => setErr('Norm konnte nicht geladen werden.'))
        .finally(() => setLoading(false));
    }
  }

  function setVerworfen(v: boolean) {
    start(async () => {
      const r = await setNormVerworfenAction({ markingId, index, zitat: refItem.zitat, verworfen: v });
      flash(r, v ? 'Engine-Norm verworfen.' : 'Norm zurückgeholt.');
      if (r.ok) onChanged();
    });
  }

  function removeOwn() {
    start(async () => {
      const r = await removeBeraterNormAction({ markingId, index, zitat: refItem.zitat });
      flash(r, 'Eigene Norm entfernt.');
      if (r.ok) onChanged();
    });
  }

  return (
    <li className={'rounded border bg-surface ' + (verworfen ? 'border-default/40 opacity-60' : 'border-default/60')}>
      <div className="flex items-center">
        <button
          type="button"
          onClick={canResolve ? toggle : undefined}
          disabled={!canResolve}
          className={'flex-1 min-w-0 flex items-start gap-1.5 px-2 py-1 text-left text-xs ' + (canResolve ? 'hover:bg-gray-50 dark:hover:bg-gray-900/40' : 'cursor-default')}
          title={canResolve ? 'Gesetzestext anzeigen' : 'Keine Norm-ID — nicht auflösbar'}
        >
          {canResolve
            ? <ChevronRight className={'h-3.5 w-3.5 shrink-0 mt-0.5 text-disabled transition-transform ' + (open ? 'rotate-90' : '')} />
            : <span className="w-3.5 shrink-0" />}
          <span className={'font-medium ' + (verworfen ? 'line-through text-disabled' : 'text-secondary')}>{refItem.zitat}</span>
          {refItem.titel && <span className="text-muted truncate">— {refItem.titel}</span>}
          {isBerater && <span className="badge-purple text-[10px] shrink-0">eigene</span>}
        </button>
        <div className="ml-auto flex items-center gap-1 pr-1.5 shrink-0">
          {isBerater ? (
            <button type="button" onClick={removeOwn} disabled={pending} title="Eigene Norm entfernen"
              className="text-disabled hover:text-red-600 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
          ) : verworfen ? (
            <button type="button" onClick={() => setVerworfen(false)} disabled={pending} title="Vorschlag zurückholen"
              className="text-[11px] text-brand hover:underline disabled:opacity-50 inline-flex items-center gap-0.5"><Undo2 className="h-3 w-3" /> zurückholen</button>
          ) : (
            <button type="button" onClick={() => setVerworfen(true)} disabled={pending} title="Engine-Vorschlag verwerfen"
              className="text-[11px] text-muted hover:text-red-600 disabled:opacity-50">verwerfen</button>
          )}
        </div>
      </div>
      {open && canResolve && (
        <div className="px-2 pb-2 pt-0.5 text-xs">
          {loading && <span className="text-muted inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> lädt …</span>}
          {err && <span className="text-red-700 dark:text-red-300">{err}</span>}
          {norm && !loading && !norm.gefunden && <span className="text-muted">Im Normkorpus nicht gefunden.</span>}
          {norm && norm.gefunden && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted">
                {[norm.titel, norm.law, norm.gueltigAb ? `gültig ab ${formatIsoDate(norm.gueltigAb)}` : null].filter(Boolean).join(' · ')}
              </p>
              <div className="max-h-72 overflow-auto rounded bg-gray-50 dark:bg-gray-900 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                {formatGesetzestext(norm.text)}
              </div>
              {norm.verweistAuf.length > 0 && (
                <p className="text-[11px] text-muted">
                  <span className="text-disabled">Verweist auf:</span> {norm.verweistAuf.map(formatNormId).join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** „Eigene Norm ergänzen": Freitext-Zitat + optionale Engine-Normgraphsuche, die
 *  eine stabile Norm-ID + Titel anhängt (→ Gesetzestext aufklappbar). */
function AddNormForm({
  clientId, markingId, pending, start, flash, onDone, onCancel,
}: {
  clientId: string; markingId: string; pending: boolean;
  start: (cb: () => void) => void; flash: Flash; onDone: () => void; onCancel: () => void;
}) {
  const field = 'w-full rounded border border-default bg-surface px-2 py-1 text-xs';
  const [zitat, setZitat] = useState('');
  const [picked, setPicked] = useState<NormHit | null>(null);
  const [hits, setHits] = useState<NormHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  function search() {
    const q = zitat.trim();
    if (q.length < 2) return;
    setSearching(true); setHits(null); setPicked(null);
    searchNormAction({ clientId, query: q })
      .then((r) => { if (r.ok) setHits(r.hits); else flash(r); })
      .catch(() => flash({ ok: false, error: 'Normsuche fehlgeschlagen.' }))
      .finally(() => setSearching(false));
  }

  // Treffer übernehmen → stabile ID + Titel anhängen (Gesetzestext wird auflösbar).
  function pick(h: NormHit) { setPicked(h); setZitat(h.zitat); setHits(null); }

  function submit() {
    const z = zitat.trim();
    if (!z) return;
    start(async () => {
      const r = await addBeraterNormAction({ markingId, zitat: z, normId: picked?.id ?? null, titel: picked?.titel ?? null });
      flash(r, 'Eigene Norm ergänzt.');
      if (r.ok) onDone();
    });
  }

  return (
    <div className="rounded border border-default/60 bg-surface p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input
          value={zitat}
          onChange={(e) => { setZitat(e.target.value); setPicked(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder="Zitat, z. B. § 42 AO"
          className={'flex-1 ' + field}
          autoFocus
        />
        <button type="button" onClick={search} disabled={searching || zitat.trim().length < 2}
          className="btn-secondary text-xs shrink-0" title="In der Engine nach stabiler Norm-ID suchen">
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </button>
      </div>
      {picked && (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          verknüpft: {picked.zitat}{picked.titel ? ` — ${picked.titel}` : ''} (Gesetzestext aufklappbar)
        </p>
      )}
      {hits && (
        hits.length === 0 ? (
          <p className="text-[11px] text-muted">Kein Normgraph-Treffer — du kannst das Zitat trotzdem als Freitext übernehmen.</p>
        ) : (
          <ul className="space-y-0.5 max-h-40 overflow-auto">
            {hits.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => pick(h)}
                  className="w-full text-left text-[11px] px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-900/40">
                  <span className="font-medium text-secondary">{h.zitat}</span>
                  {h.titel && <span className="text-muted"> — {h.titel}</span>}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={pending || zitat.trim().length === 0} className="btn-primary text-xs">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Übernehmen
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="text-xs text-muted hover:underline">Abbrechen</button>
      </div>
    </div>
  );
}

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
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
