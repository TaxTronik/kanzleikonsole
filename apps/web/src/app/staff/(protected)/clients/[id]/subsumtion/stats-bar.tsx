'use client';

import { Wand2, Loader2 } from 'lucide-react';
import type { MarkingDTO } from './_ui';

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
}: {
  markings: MarkingDTO[];
  llmEnrichedAt: string | null;
  engineConfigured: boolean;
  pending: boolean;
  onRequestLlm: () => void;
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
        <button
          type="button"
          onClick={onRequestLlm}
          disabled={pending || !engineConfigured}
          className="btn-secondary text-xs"
          title="LLM-Schicht asynchron dazuschalten"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          LLM dazuschalten +
        </button>
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
