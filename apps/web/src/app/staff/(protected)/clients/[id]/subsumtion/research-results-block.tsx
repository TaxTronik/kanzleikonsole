'use client';

import { useRouter } from 'next/navigation';
import { Inbox, Sparkles, Check } from 'lucide-react';
import { assignResultAction } from './actions';
import type { ResearchResultDTO, MarkingDTO } from './_ui';

export function ResearchResultsBlock(props: {
  clientId: string;
  analysisId: string;
  results: ResearchResultDTO[];
  markingsById: Record<string, MarkingDTO>;
  pending: boolean;
  start: (cb: () => void) => void;
  onFlash: (r: { ok: boolean; error?: string }, ok?: string) => void;
}) {
  const router = useRouter();
  if (props.results.length === 0) return null;

  function assign(resultId: string, markingId: string | null) {
    props.start(async () => {
      const r = await assignResultAction({
        clientId: props.clientId,
        analysisId: props.analysisId,
        resultId,
        markingId,
      });
      props.onFlash(r, markingId ? 'Ergebnis zugeordnet.' : 'Ergebnis verworfen.');
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="card p-4">
      <h2 className="text-sm font-medium text-primary mb-3 inline-flex items-center gap-2">
        <Inbox className="h-4 w-4 text-disabled" /> Rechercheergebnisse
        <span className="badge-gray text-[10px]">{props.results.length}</span>
      </h2>
      <ul className="divide-y divide-border-subtle">
        {props.results.map((res) => {
          const assignedTo = res.markingId ? props.markingsById[res.markingId] : null;
          return (
            <li key={res.id} className="py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium text-primary">
                  {res.title || 'Recherche-Ergebnis'}
                </span>
                {res.status === 'ZUGEORDNET' && assignedTo ? (
                  <span className="badge-green text-[10px]">→ {assignedTo.begriff}</span>
                ) : (
                  <span className="badge-yellow text-[10px]">neu</span>
                )}
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">Ergebnis anzeigen</summary>
                <p className="mt-1 whitespace-pre-wrap text-secondary">{res.body}</p>
              </details>

              {res.status === 'NEU' && (
                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                  <span className="text-[11px] text-muted inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> zuordnen:
                  </span>
                  {res.suggestions.length > 0 ? (
                    res.suggestions.map((s) => (
                      <button
                        key={s.markingId}
                        type="button"
                        onClick={() => assign(res.id, s.markingId)}
                        disabled={props.pending}
                        className="btn-secondary text-[11px] py-0.5"
                        title={s.reason}
                      >
                        <Check className="h-3 w-3" /> {s.begriff}
                      </button>
                    ))
                  ) : (
                    <span className="text-[11px] text-disabled">kein Vorschlag</span>
                  )}
                  <button
                    type="button"
                    onClick={() => assign(res.id, null)}
                    disabled={props.pending}
                    className="text-[11px] text-disabled hover:text-secondary ml-1"
                  >
                    verwerfen
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
