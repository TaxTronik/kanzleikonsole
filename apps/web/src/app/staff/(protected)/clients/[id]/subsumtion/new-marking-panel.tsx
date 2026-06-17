'use client';

import { useEffect, useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { addManualMarkingAction } from './actions';

const SWATCHES = ['#f59e0b', '#ef4444', '#10b981', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];

export function NewMarkingPanel(props: {
  clientId: string;
  analysisId: string;
  selection: { start: number; end: number; text: string } | null;
  pending: boolean;
  start: (cb: () => void) => void;
  onDone: (r: { ok: boolean; error?: string }) => void;
}) {
  const [begriff, setBegriff] = useState('');
  const [farbe, setFarbe] = useState<string>(SWATCHES[0]!);
  const [label, setLabel] = useState('');
  const [notiz, setNotiz] = useState('');
  const [norm, setNorm] = useState('');

  // Begriff automatisch mit dem markierten Text vorbefüllen — kein Pflicht-Tippen.
  const selStart = props.selection?.start;
  const selEnd = props.selection?.end;
  const selectedText = props.selection?.text ?? null;
  useEffect(() => {
    if (selectedText) setBegriff(selectedText.trim().replace(/\s+/g, ' '));
  }, [selStart, selEnd, selectedText]);

  function submit() {
    const sel = props.selection;
    if (!sel) { props.onDone({ ok: false, error: 'Bitte zuerst eine Textstelle markieren.' }); return; }
    if (!begriff.trim()) { props.onDone({ ok: false, error: 'Bitte einen Begriff angeben.' }); return; }
    const normAnker = norm.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    props.start(async () => {
      const r = await addManualMarkingAction({
        clientId: props.clientId,
        analysisId: props.analysisId,
        start: sel.start,
        end: sel.end,
        begriff: begriff.trim(),
        farbe,
        label: label.trim() || null,
        notiz: notiz.trim() || null,
        normAnker,
      });
      props.onDone(r);
      if (r.ok) { setBegriff(''); setLabel(''); setNotiz(''); setNorm(''); }
    });
  }

  return (
    <div className="card p-4 space-y-3 text-sm">
      <p className="font-medium text-primary">Neue eigene Markierung</p>

      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Markiert</p>
        {props.selection ? (
          <div className="rounded border border-default bg-surface px-2 py-1.5">
            „{props.selection.text}"{' '}
            <span className="text-muted text-xs">({props.selection.start}–{props.selection.end})</span>
          </div>
        ) : (
          <p className="text-xs text-disabled">Im Dokument über eine Textstelle ziehen …</p>
        )}
      </div>

      <label className="block text-xs">
        <span className="text-muted">Begriff <span className="text-disabled">(vorbefüllt mit dem markierten Text — anpassbar)</span></span>
        <input value={begriff} onChange={(e) => setBegriff(e.target.value)} placeholder="Begriff der markierten Stelle" className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>

      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Farbe</p>
        <div className="flex items-center gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFarbe(c)}
              className={'h-6 w-6 rounded-full border-2 ' + (farbe === c ? 'border-primary' : 'border-transparent')}
              style={{ backgroundColor: c }}
              aria-label={c}
            >
              {farbe === c && <Check className="h-3.5 w-3.5 mx-auto text-white" />}
            </button>
          ))}
        </div>
      </div>

      <label className="block text-xs">
        <span className="text-muted">Label / Kategorie</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. kritisch, offen, Mandantenfrage" className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>

      <label className="block text-xs">
        <span className="text-muted">Notiz</span>
        <textarea value={notiz} onChange={(e) => setNotiz(e.target.value)} rows={2} placeholder="optional" className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>

      <label className="block text-xs">
        <span className="text-muted">Norm (optional — Komma-getrennt)</span>
        <input value={norm} onChange={(e) => setNorm(e.target.value)} placeholder="z. B. § 162 AO, § 158 AO" className="mt-0.5 w-full rounded border border-default bg-surface px-2 py-1" />
      </label>

      <button type="button" onClick={submit} disabled={props.pending || !props.selection} className="btn-primary text-xs w-full justify-center">
        <Plus className="h-3.5 w-3.5" /> Markierung speichern
      </button>
      <p className="text-[11px] text-muted">
        Governance-Matrix nach dem Speichern über die Markierung setzen.
      </p>
    </div>
  );
}
