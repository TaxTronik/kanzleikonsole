'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Check, FolderCheck, FolderOpen, Inbox, Sparkles, Trash2 } from 'lucide-react';
import { assignResultAction, saveResultToShelfAction } from './research-actions';
import { renderMarkdown } from '@/lib/markdown';
import type { ResearchResultDTO, MarkingDTO } from './_ui';

// Recherche-Ergebnisse kommen (v. a. aus n8n) als Markdown — inkl. Überschriften,
// Tabellen und Zitaten. renderMarkdown escapet jeden Textblock (kein
// HTML-Passthrough), daher ist dangerouslySetInnerHTML hier sicher.
const RESULT_PROSE_CLASS =
  'mt-2 text-sm text-secondary space-y-2 leading-relaxed ' +
  '[&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-primary [&_h1]:mt-4 ' +
  '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-primary [&_h2]:mt-4 ' +
  '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-primary [&_h3]:mt-3 ' +
  '[&_h4]:text-sm [&_h4]:font-semibold [&_h4]:text-primary ' +
  '[&_p]:my-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5 [&_li]:my-1 ' +
  '[&_a]:text-brand-700 [&_a:hover]:underline ' +
  '[&_code]:bg-gray-100 dark:[&_code]:bg-gray-800 [&_code]:px-1 [&_code]:rounded ' +
  '[&_pre]:bg-gray-100 dark:[&_pre]:bg-gray-800 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto ' +
  '[&_blockquote]:border-l-4 [&_blockquote]:border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted ' +
  '[&_hr]:my-4 [&_hr]:border-border-subtle ' +
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-3 ' +
  '[&_th]:border [&_th]:border-default [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-primary ' +
  '[&_td]:border [&_td]:border-default [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top';

export function ResearchResultDetails({ body }: { body: string }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted">Ergebnis anzeigen</summary>
      <div
        className={RESULT_PROSE_CLASS}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
      />
    </details>
  );
}

export function ResearchResultsBlock(props: {
  clientId: string;
  analysisId: string;
  results: ResearchResultDTO[];
  markingsById: Record<string, MarkingDTO>;
  pending: boolean;
  start: (cb: () => void) => void;
  onFlash: (r: { ok: boolean; error?: string }, ok?: string) => void;
  onArchive: (result: ResearchResultDTO) => void;
  onDelete: (result: ResearchResultDTO) => void;
}) {
  const router = useRouter();
  const saveLocks = useRef(new Set<string>());
  const [savingResultIds, setSavingResultIds] = useState<Set<string>>(new Set());
  const [optimisticSave, setOptimisticSave] = useState<{
    resultId: string;
    source: ResearchResultDTO[];
  } | null>(null);
  if (props.results.length === 0) return null;

  function assign(resultId: string, markingId: string) {
    props.start(async () => {
      const r = await assignResultAction({
        clientId: props.clientId,
        analysisId: props.analysisId,
        resultId,
        markingId,
      });
      props.onFlash(r, 'Ergebnis zugeordnet.');
      if (r.ok) router.refresh();
    });
  }

  function saveToShelf(resultId: string) {
    if (saveLocks.current.has(resultId)) return;
    saveLocks.current.add(resultId);
    setSavingResultIds((current) => new Set(current).add(resultId));
    props.start(async () => {
      try {
        const r = await saveResultToShelfAction({ resultId });
        props.onFlash(
          r,
          r.ok && r.alreadySaved
            ? 'Dieses Rechercheergebnis liegt bereits im Aktenregal.'
            : 'Als Markdown-Dokument im Aktenregal gespeichert.',
        );
        if (r.ok) {
          setOptimisticSave({ resultId, source: props.results });
          router.refresh();
        }
      } finally {
        saveLocks.current.delete(resultId);
        setSavingResultIds((current) => {
          const next = new Set(current);
          next.delete(resultId);
          return next;
        });
      }
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
          const savedToShelf =
            Boolean(res.shelfDocumentId) ||
            (optimisticSave?.resultId === res.id && optimisticSave.source === props.results);
          const savingToShelf = savingResultIds.has(res.id);
          return (
            <li key={res.id} className="py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-medium text-primary">
                  {res.title || res.requestTitle || 'Recherche-Ergebnis'}
                </span>
                <span className="flex items-center gap-1.5">
                  {res.status === 'ZUGEORDNET' && assignedTo ? (
                    <span className="badge-green text-[10px]">→ {assignedTo.begriff}</span>
                  ) : res.status === 'VERWORFEN' ? (
                    // Seit die Prüfentscheidung existiert, kommt der Status auch
                    // hier an — vorher bog die Seite ihn beim Laden auf NEU zurück.
                    <span className="badge-gray text-[10px]">verworfen</span>
                  ) : (
                    <span className="badge-yellow text-[10px]">neu</span>
                  )}
                  <button
                    type="button"
                    onClick={() => saveToShelf(res.id)}
                    disabled={props.pending || savingToShelf || savedToShelf}
                    className="btn-secondary text-[11px] py-0.5"
                    title={
                      savedToShelf
                        ? 'Dieses Rechercheergebnis wurde bereits im Aktenregal abgelegt'
                        : 'Als Markdown-Dokument im Aktenregal dieses Sachverhalts ablegen'
                    }
                  >
                    {savedToShelf ? (
                      <>
                        <FolderCheck className="h-3 w-3" /> Im Aktenregal
                      </>
                    ) : (
                      <>
                        <FolderOpen className="h-3 w-3" />
                        {savingToShelf ? 'Wird abgelegt …' : 'Ins Aktenregal'}
                      </>
                    )}
                  </button>
                </span>
              </div>
              <ResearchResultDetails body={res.body} />

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
                </div>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => props.onArchive(res)}
                  disabled={props.pending}
                  className="text-[11px] text-muted hover:text-primary inline-flex items-center gap-1"
                >
                  <Archive className="h-3 w-3" /> Archivieren
                </button>
                <button
                  type="button"
                  onClick={() => props.onDelete(res)}
                  disabled={props.pending}
                  className="text-[11px] text-red-600 hover:text-red-700 inline-flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> Löschen
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
