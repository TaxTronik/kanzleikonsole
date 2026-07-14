'use client';

import { Wand2, Loader2 } from 'lucide-react';
import type { MarkingDTO } from './_ui';
import type { LlmStatusDTO } from '@/server/risk/llm';

function queueText(q: LlmStatusDTO['queue']): string | null {
  if (!q) return null;
  if (q.slotsGesamt != null) return `${q.aktiv ?? 0}/${q.slotsGesamt} Slots aktiv`;
  if (q.aktiv != null || q.wartend != null)
    return `${q.aktiv ?? 0} aktiv · ${q.wartend ?? 0} wartend`;
  return null;
}

/** Live-Status von Schicht 2 + Queue. „lädt" NUR, wenn der Server tatsächlich
 *  hochfährt (von uns gestartet bzw. gerade angestoßen) — nicht schon, wenn er
 *  bloß bereit, aber aus ist (dann „KI aus"). */
function LlmIndicator({ s, starting }: { s: LlmStatusDTO; starting: boolean }) {
  const q = queueText(s.queue);
  if (s.verfuegbar) {
    return (
      <span
        className="text-xs text-emerald-600 inline-flex items-center gap-1"
        title="LLM-Server bereit"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" /> KI verfügbar
        {q ? <span className="text-muted"> · {q}</span> : null}
      </span>
    );
  }
  if (s.binaryVorhanden === false) {
    return (
      <span
        className="text-xs text-muted inline-flex items-center gap-1"
        title="In der Engine ist kein LLM-Binary konfiguriert"
      >
        <span className="h-2 w-2 rounded-full bg-gray-400" /> KI nicht installiert
      </span>
    );
  }
  if (starting || s.vonUnsGestartet) {
    return (
      <span
        className="text-xs text-amber-600 inline-flex items-center gap-1"
        title="LLM-Server startet / lädt das Modell"
      >
        <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" /> KI lädt …
        {q ? <span className="text-muted"> · {q}</span> : null}
      </span>
    );
  }
  // Binary vorhanden, aber Server läuft nicht und wurde nicht angestoßen.
  return (
    <span
      className="text-xs text-muted inline-flex items-center gap-1"
      title="Der LLM-Server läuft nicht — „LLM dazuschalten“ startet ihn bei Bedarf."
    >
      <span className="h-2 w-2 rounded-full bg-gray-400" /> KI aus
    </span>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="text-center">
      <div className={'text-2xl font-bold leading-none ' + color}>{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted mt-1">{label}</div>
    </div>
  );
}

const GOV_CHIP: Record<'FP' | 'FF' | 'IN', string> = {
  FP: 'badge-brand',
  FF: 'badge-purple',
  IN: 'badge-gray',
};

export function StatsBar({
  markings,
  llmEnrichedAt,
  engineConfigured,
  pending,
  onRequestLlm,
  llmStatus,
  llmStarting,
}: {
  markings: MarkingDTO[];
  llmEnrichedAt: string | null;
  engineConfigured: boolean;
  pending: boolean;
  onRequestLlm: () => void;
  llmStatus?: LlmStatusDTO | null;
  llmStarting?: boolean;
}) {
  const count = (fn: (m: MarkingDTO) => boolean) => markings.filter(fn).length;
  const treffer = count((m) => m.engineStatus === 'treffer');
  const luecken = count((m) => m.engineStatus === 'luecke');
  const unknown = count((m) => m.engineStatus === 'unknown_risiko');
  const beraterDef = count((m) => m.herkunft === 'BERATER');
  const gov = (t: 'FP' | 'FF' | 'IN') => count((m) => m.governanceTyp === t);

  return (
    <div className="card p-4 flex items-center gap-6 flex-wrap">
      <Stat n={treffer} label="Treffer" color="text-emerald-600" />
      <Stat n={luecken} label="Lücken" color="text-red-600" />
      <Stat n={unknown} label="Unknown-Risiko" color="text-amber-600" />
      <Stat n={beraterDef} label="Berater-Def." color="text-teal-600" />

      {llmEnrichedAt ? (
        <span className="badge-purple text-xs">KI-vertieft</span>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onRequestLlm}
            disabled={pending || !engineConfigured || llmStarting}
            className="btn-secondary text-xs"
            title="LLM-Schicht asynchron dazuschalten (startet den Server bei Bedarf selbst)"
          >
            {pending || llmStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {llmStarting ? 'Vertiefung läuft …' : 'LLM dazuschalten +'}
          </button>
          {engineConfigured && llmStatus ? (
            <LlmIndicator s={llmStatus} starting={!!llmStarting} />
          ) : null}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5 flex-wrap">
        {(['FP', 'FF', 'IN'] as const).map((t) =>
          gov(t) > 0 ? (
            <span key={t} className={GOV_CHIP[t] + ' text-[10px]'}>
              {t} {gov(t)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
