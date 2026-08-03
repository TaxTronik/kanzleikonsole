'use client';

// =============================================================================
// Recherche-Hub (3. View im Subsumtions-Workspace).
//
// Eine Sicht pro Sachverhalt: freier Composer, aktive Ergebnisse sowie gesendete
// Aufträge mit ihren archivierten Ergebnissen. Archivierung ist reversibel;
// endgültiges Löschen läuft ausschließlich über das gemeinsame ConfirmModal.
// =============================================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArchiveRestore, MessageSquarePlus, Send, Trash2, Webhook } from 'lucide-react';
import { ResearchComposer } from './research-composer';
import { ResearchResultDetails, ResearchResultsBlock } from './research-results-block';
import { archiveResultAction, deleteResultAction } from './actions';
import { ConfirmModal } from '@/components/ui/modal';
import { fmtDateShort } from '@/lib/fmt';
import type { ResearchRequestDTO, ResearchResultDTO, MarkingDTO } from './_ui';

const REQ_STATUS: Record<ResearchRequestDTO['status'], { label: string; cls: string }> = {
  SENT: { label: 'Gesendet', cls: 'badge-yellow' },
  ANSWERED: { label: 'Beantwortet', cls: 'badge-green' },
  FAILED: { label: 'Fehlgeschlagen', cls: 'badge-red' },
};

function ArchivedResultRow(props: {
  result: ResearchResultDTO;
  pending: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const title = props.result.title || props.result.requestTitle || 'Recherche-Ergebnis';
  return (
    <li className="rounded border border-border-subtle p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-medium text-primary">{title}</span>
        <span className="badge-gray text-[10px]">archiviert</span>
      </div>
      <ResearchResultDetails body={props.result.body} />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={props.onRestore}
          disabled={props.pending}
          className="text-[11px] text-brand-700 dark:text-brand-300 hover:underline inline-flex items-center gap-1"
        >
          <ArchiveRestore className="h-3 w-3" /> Reaktivieren
        </button>
        <button
          type="button"
          onClick={props.onDelete}
          disabled={props.pending}
          className="text-[11px] text-red-600 hover:text-red-700 inline-flex items-center gap-1"
        >
          <Trash2 className="h-3 w-3" /> Löschen
        </button>
      </div>
    </li>
  );
}

export function ResearchView(props: {
  clientId: string;
  analysisId: string;
  requests: ResearchRequestDTO[];
  results: ResearchResultDTO[];
  archivedResults: ResearchResultDTO[];
  markingsById: Record<string, MarkingDTO>;
  staffOptions: Array<{ id: string; fullName: string }>;
  engineConfigured: boolean;
  pending: boolean;
  start: (cb: () => void) => void;
  onFlash: (r: { ok: boolean; error?: string }, ok?: string) => void;
  onSelectMarking: (markingId: string) => void;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ResearchResultDTO | null>(null);
  const staffById = Object.fromEntries(
    props.staffOptions.map((staff) => [staff.id, staff.fullName]),
  );

  function setArchived(result: ResearchResultDTO, archived: boolean) {
    props.start(async () => {
      const response = await archiveResultAction({ resultId: result.id, archived });
      props.onFlash(response, archived ? 'Recherche archiviert.' : 'Recherche reaktiviert.');
      if (response.ok) router.refresh();
    });
  }

  const orphanedArchivedResults = props.archivedResults.filter((result) => !result.requestId);

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-primary inline-flex items-center gap-2">
            <Webhook className="h-4 w-4 text-disabled" /> Rechercheauftrag
          </h2>
          {!composing && (
            <button
              type="button"
              onClick={() => setComposing(true)}
              disabled={!props.engineConfigured}
              className="btn-primary text-xs"
              title={props.engineConfigured ? undefined : 'Engine nicht konfiguriert'}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> Neue Recherche-Frage
            </button>
          )}
        </div>
        <p className="text-xs text-muted mt-1">
          Eine gezielte Recherche mit eigenem, reduziertem Sachverhalt erstellen. Der vollständige
          Sachverhalt wird nur nach bewusster Auswahl übermittelt.
        </p>
        {composing && (
          <div className="mt-3">
            <ResearchComposer
              clientId={props.clientId}
              analysisId={props.analysisId}
              markingId={null}
              pending={props.pending}
              start={props.start}
              onClose={() => setComposing(false)}
              onDone={(response) => {
                props.onFlash(response, 'Anonymisierter Rechercheauftrag an n8n gesendet.');
                if (response.ok) {
                  setComposing(false);
                  router.refresh();
                }
              }}
            />
          </div>
        )}
      </div>

      {props.results.length === 0 ? (
        <div className="card p-4">
          <h2 className="text-sm font-medium text-primary mb-1">Rechercheergebnisse</h2>
          <p className="text-xs text-muted">Noch keine aktiven Ergebnisse vorhanden.</p>
        </div>
      ) : (
        <ResearchResultsBlock
          clientId={props.clientId}
          analysisId={props.analysisId}
          results={props.results}
          markingsById={props.markingsById}
          pending={props.pending}
          start={props.start}
          onFlash={props.onFlash}
          onArchive={(result) => setArchived(result, true)}
          onDelete={setDeleteTarget}
        />
      )}

      <details className="card p-4 group">
        <summary className="cursor-pointer list-none text-sm font-medium text-primary inline-flex items-center gap-2 select-none">
          <Send className="h-4 w-4 text-disabled" /> Gesendete Aufträge
          <span className="badge-gray text-[10px]">{props.requests.length}</span>
          {props.archivedResults.length > 0 && (
            <span className="badge-gray text-[10px]">
              {props.archivedResults.length} archiviert
            </span>
          )}
          <span className="text-[11px] font-normal text-disabled group-open:hidden">
            — anzeigen
          </span>
          <span className="hidden text-[11px] font-normal text-disabled group-open:inline">
            — verbergen
          </span>
        </summary>
        {props.requests.length === 0 ? (
          <p className="text-xs text-muted mt-3">Noch keine Rechercheaufträge gesendet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle mt-3">
            {props.requests.map((request) => {
              const requestStatus = REQ_STATUS[request.status];
              const archivedResults = props.archivedResults.filter(
                (result) => result.requestId === request.id,
              );
              return (
                <li key={request.id} className="py-2.5 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-primary block truncate">
                        {request.title ?? (request.begriff || 'Recherche')}
                      </span>
                      {request.begriff && request.markingId ? (
                        <button
                          type="button"
                          onClick={() => props.onSelectMarking(request.markingId!)}
                          className="text-xs text-brand-700 dark:text-brand-300 hover:underline text-left truncate block max-w-full"
                        >
                          → {request.begriff}
                        </button>
                      ) : (
                        <span className="text-xs text-secondary">Allgemeine Recherchefrage</span>
                      )}
                      {request.prompt && (
                        <p className="text-xs text-muted mt-0.5 line-clamp-2">{request.prompt}</p>
                      )}
                      <p className="text-[11px] text-disabled mt-0.5">
                        {staffById[request.createdById] ?? 'Mitarbeiter'} ·{' '}
                        {fmtDateShort(new Date(request.createdAt))}
                        {request.includeSachverhalt ? ' · mit Hauptsachverhalt' : ''}
                        {request.resultCount > 0 ? ` · ${request.resultCount} Antwort(en)` : ''}
                      </p>
                    </div>
                    <span className={`${requestStatus.cls} text-[10px] shrink-0`}>
                      {requestStatus.label}
                    </span>
                  </div>
                  {archivedResults.length > 0 && (
                    <details className="rounded bg-surface-sunken p-2">
                      <summary className="cursor-pointer text-xs text-secondary">
                        Archivierte Ergebnisse ({archivedResults.length})
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {archivedResults.map((result) => (
                          <ArchivedResultRow
                            key={result.id}
                            result={result}
                            pending={props.pending}
                            onRestore={() => setArchived(result, false)}
                            onDelete={() => setDeleteTarget(result)}
                          />
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {orphanedArchivedResults.length > 0 && (
          <div className="mt-3 border-t border-border-subtle pt-3">
            <p className="text-xs font-medium text-secondary mb-2">
              Weitere archivierte Ergebnisse
            </p>
            <ul className="space-y-2">
              {orphanedArchivedResults.map((result) => (
                <ArchivedResultRow
                  key={result.id}
                  result={result}
                  pending={props.pending}
                  onRestore={() => setArchived(result, false)}
                  onDelete={() => setDeleteTarget(result)}
                />
              ))}
            </ul>
          </div>
        )}
      </details>

      {deleteTarget && (
        <ConfirmModal
          danger
          title="Recherche löschen"
          message={
            <>
              <p>
                Die Recherche „
                {deleteTarget.title || deleteTarget.requestTitle || 'Recherche-Ergebnis'}“ wirklich
                endgültig löschen?
              </p>
              <p className="mt-2 text-xs text-muted">
                Ein bereits erzeugtes Dokument im Aktenregal bleibt bestehen. Dieser Vorgang kann
                nicht rückgängig gemacht werden.
              </p>
            </>
          }
          confirmLabel="Löschen"
          busyLabel="Löscht…"
          onConfirm={async () => {
            const response = await deleteResultAction({ resultId: deleteTarget.id });
            if (response.ok) {
              props.onFlash(response, 'Recherche endgültig gelöscht.');
              router.refresh();
            }
            return response;
          }}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
