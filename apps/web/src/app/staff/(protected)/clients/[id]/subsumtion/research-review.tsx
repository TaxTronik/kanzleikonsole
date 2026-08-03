'use client';

import { ResearchResultDetails } from './research-results-block';
import { assignResultAction, setResultVerworfenAction, saveResultToShelfAction } from './actions';
import type { ResearchResultDTO, Flash } from './_ui';

/**
 * Prüfung der Rechercheergebnisse — direkt an der Markierung.
 *
 * Vorher lagen die Ergebnisse ausschliesslich im separaten Recherche-Tab, also
 * genau nicht dort, wohin die Zuweisungs-Benachrichtigung fuehrt. Und eine
 * Pruefentscheidung gab es gar nicht: `VERWORFEN` stand im Schema, wurde von
 * keiner Aktion gesetzt und beim Laden auf `NEU` zurueckgebogen.
 *
 * Zwei Entscheidungen, beide fuer die zugewiesene Person zugaenglich:
 * uebernehmen (ordnet zu) oder verwerfen (bleibt nachvollziehbar erhalten,
 * statt geloescht zu werden). Die Ablage im Aktenregal bleibt der vollen Stufe.
 */
export function ResearchReviewSection(props: {
  results: ResearchResultDTO[];
  clientId: string;
  analysisId: string;
  markingId: string;
  canReview: boolean;
  canShelve: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onChanged: () => void;
  flash: Flash;
}) {
  const { results, clientId, analysisId, markingId, canReview, canShelve, pending, start } = props;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    start(async () => {
      const r = await fn();
      props.flash(r, ok);
      if (r.ok) props.onChanged();
    });
  }

  return (
    <section className="rounded-md border border-default p-2 space-y-2">
      <h4 className="text-xs font-medium text-secondary">Rechercheergebnisse ({results.length})</h4>
      {results.map((r) => (
        <article key={r.id} className="rounded bg-surface-raised p-2 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-primary truncate">
              {r.title || r.requestTitle || 'Ergebnis'}
            </span>
            <span
              className={
                r.status === 'ZUGEORDNET'
                  ? 'badge-green text-[11px]'
                  : r.status === 'VERWORFEN'
                    ? 'badge-gray text-[11px]'
                    : 'badge-brand text-[11px]'
              }
            >
              {r.status === 'ZUGEORDNET'
                ? 'übernommen'
                : r.status === 'VERWORFEN'
                  ? 'verworfen'
                  : 'ungeprüft'}
            </span>
          </div>
          <ResearchResultDetails body={r.body} />
          {canReview && r.status !== 'ZUGEORDNET' && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={pending}
                className="btn-primary text-[11px]"
                onClick={() =>
                  run(
                    () => assignResultAction({ clientId, analysisId, resultId: r.id, markingId }),
                    'Ergebnis übernommen.',
                  )
                }
              >
                Übernehmen
              </button>
              {r.status !== 'VERWORFEN' && (
                <button
                  type="button"
                  disabled={pending}
                  className="btn-secondary text-[11px]"
                  onClick={() =>
                    run(
                      () =>
                        setResultVerworfenAction({
                          clientId,
                          analysisId,
                          resultId: r.id,
                          markingId,
                        }),
                      'Ergebnis verworfen.',
                    )
                  }
                >
                  Verwerfen
                </button>
              )}
            </div>
          )}
          {canShelve && !r.shelfDocumentId && (
            <button
              type="button"
              disabled={pending}
              className="btn-secondary text-[11px]"
              onClick={() =>
                run(() => saveResultToShelfAction({ resultId: r.id }), 'Ins Aktenregal gelegt.')
              }
            >
              Ins Aktenregal
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
