'use client';
import Link from 'next/link';
import {
  Archive,
  Lock,
  RefreshCw,
  Eye,
  EyeOff,
  Webhook,
  Loader2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { ExportPanel } from './export-panel';
import type { AnalysisDTO, MarkingDTO } from './_ui';

export function SubsumtionReviewControls({
  clientId,
  initial,
  canWrite,
  pending,
  engineConfigured,
  pollLlm,
  onReanalyze,
  onArchive,
  onToggleCaseResearch,
  onToggleVertraulich,
  markings,
}: {
  clientId: string;
  initial: AnalysisDTO;
  canWrite: boolean;
  pending: boolean;
  engineConfigured: boolean;
  pollLlm: boolean;
  onReanalyze: () => void;
  onArchive: () => void;
  onToggleCaseResearch: () => void;
  onToggleVertraulich: () => void;
  markings: MarkingDTO[];
}) {
  return (
    <>
      {' '}
      {/* Toolbar — bestehende TaxTronik-Features verlinkt */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link href={`/staff/clients/${clientId}/subsumtion/new`} className="btn-secondary text-xs">
          ‹ Neue Analyse
        </Link>
        <ExportPanel clientId={clientId} analysisId={initial.id} markings={markings} />
        {initial.archivedAt ? (
          <span
            className="badge-gray text-xs inline-flex items-center gap-1 ml-auto"
            title="Revisionssicher archiviert (Object-Lock)"
          >
            <Lock className="h-3.5 w-3.5" /> Archiviert {fmtDateShort(new Date(initial.archivedAt))}
          </span>
        ) : !canWrite ? (
          <span
            className="badge-gray text-xs inline-flex items-center gap-1 ml-auto"
            title="Bearbeitung nur durch Admin/Partner oder zuständige Berufsträger"
          >
            <Lock className="h-3.5 w-3.5" /> Leseansicht
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={onReanalyze}
              disabled={pending || !engineConfigured || pollLlm}
              className="btn-secondary text-xs ml-auto"
              title="Engine erneut (deterministisch) laufen lassen — ergänzt nur neue Markierungen, deine Bewertungen bleiben"
            >
              {pending || pollLlm ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}{' '}
              Neu analysieren
            </button>
            <button
              type="button"
              onClick={onArchive}
              disabled={pending}
              className="btn-secondary text-xs"
              title="Revisionssicher archivieren (GoBD, schreibgeschützt)"
            >
              <Archive className="h-3.5 w-3.5" /> Archivieren
            </button>
            <button type="button" onClick={onToggleCaseResearch} className="btn-secondary text-xs">
              <Webhook className="h-3.5 w-3.5" /> Ganzer Fall an KI
            </button>
            <button
              type="button"
              onClick={onToggleVertraulich}
              disabled={pending}
              className={initial.vertraulich ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
              title={
                initial.vertraulich
                  ? 'Vertraulichkeit aufheben — zugewiesene Mitarbeitende sehen dann wieder den ganzen Sachverhalt'
                  : 'Als vertraulich kennzeichnen — zugewiesene Mitarbeitende sehen dann nur ihre Textstelle'
              }
            >
              {initial.vertraulich ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}{' '}
              {initial.vertraulich ? 'Vertraulich' : 'Vertraulich?'}
            </button>
          </>
        )}
      </div>
      {initial.verdeckt && (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/25 px-3 py-2 text-xs text-amber-900 dark:text-amber-100 inline-flex items-center gap-2">
          <EyeOff className="h-3.5 w-3.5 shrink-0" />
          Diese Subsumtion ist <strong>vertraulich</strong>. Du siehst ausschliesslich die dir
          zugewiesenen Textstellen — nicht den vollstaendigen Sachverhalt.
        </div>
      )}
      {initial.vertraulich && canWrite && (
        <div className="rounded-md border border-default bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-secondary inline-flex items-center gap-2">
          <EyeOff className="h-3.5 w-3.5 text-disabled shrink-0" />
          Als <strong>vertraulich</strong> gekennzeichnet: Zugewiesene Mitarbeitende ohne
          Schreibrecht sehen nur ihre eigene Textstelle, nicht den ganzen Sachverhalt.
        </div>
      )}
      {initial.archivedAt && (
        <div className="rounded-md border border-default bg-gray-50 dark:bg-gray-900/40 px-3 py-2 text-xs text-secondary inline-flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-disabled shrink-0" />
          Diese Subsumtion ist <strong>revisionssicher archiviert</strong> (GoBD-Snapshot,
          Object-Lock) und <strong>schreibgeschützt</strong> — Markierungen/Bewertungen lassen sich
          nicht mehr ändern. Ansicht + Export bleiben verfügbar.
        </div>
      )}
    </>
  );
}

function llmProgressCopy(
  jobState: string | null,
  workerAvailable: boolean | null,
): { title: string; detail: string } {
  if (jobState === 'active') {
    return { title: 'KI-Vertiefung läuft …', detail: 'im Hintergrund' };
  }
  if (workerAvailable === false) {
    return {
      title: 'KI-Vertiefung wartet auf Worker …',
      detail: 'lokal mit „pnpm dev“ starten',
    };
  }
  return { title: 'KI-Vertiefung wartet …', detail: 'in der Warteschlange' };
}

export function SubsumtionLlmFeedback({
  pollLlm,
  llmJobState,
  llmWorkerAvailable,
  llmFailed,
  setLlmFailed,
  requestLlm,
  pending,
  engineConfigured,
  archived,
}: {
  pollLlm: boolean;
  llmJobState: string | null;
  llmWorkerAvailable: boolean | null;
  llmFailed: string | null;
  setLlmFailed: (message: string | null) => void;
  requestLlm: () => void;
  pending: boolean;
  engineConfigured: boolean;
  archived: boolean;
}) {
  const llmProgress = llmProgressCopy(llmJobState, llmWorkerAvailable);
  return (
    <>
      {' '}
      {/* Flying Pill: fixed → immer sichtbar, egal ob ein Marking-Panel offen ist
          oder wie weit gescrollt wurde (auch über dem Vollbild-Dokument, z-50). */}
      {pollLlm && !llmFailed && (
        <div
          className="fixed bottom-6 right-6 z-50 inline-flex items-center gap-2 rounded-full border border-purple-300 dark:border-purple-700 bg-purple-50/95 dark:bg-purple-900/90 px-4 py-2 text-sm text-purple-800 dark:text-purple-100 shadow-lg backdrop-blur"
          role="status"
          aria-live="polite"
          title="Die neuen Markierungen erscheinen automatisch, sobald der Lauf fertig ist. Du kannst weiterarbeiten."
        >
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <span>
            <strong>{llmProgress.title}</strong>{' '}
            <span className="font-normal text-purple-600 dark:text-purple-300">
              {llmProgress.detail}
            </span>
          </span>
        </div>
      )}
      {llmFailed && (
        <div className="alert-error-sm flex items-start justify-between gap-3">
          <span className="inline-flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              <strong>KI-Vertiefung fehlgeschlagen.</strong> {llmFailed}
            </span>
          </span>
          <span className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setLlmFailed(null);
                requestLlm();
              }}
              disabled={pending || !engineConfigured || archived || pollLlm}
              className="btn-secondary text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Erneut versuchen
            </button>
            <button
              type="button"
              onClick={() => setLlmFailed(null)}
              className="text-disabled hover:text-secondary"
              title="Schließen"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}
    </>
  );
}
