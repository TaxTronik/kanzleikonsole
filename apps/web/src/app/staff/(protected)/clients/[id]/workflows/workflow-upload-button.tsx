'use client';

import { useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Upload, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { useDocumentCommit } from '@/components/use-document-commit';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';

interface Props {
  itemId: string;
  clientId: string;
  itemTitle: string;
  expectedClassification: string;
  /**
   * Wird nach jedem erfolgreichen Upload aufgerufen. Aufrufer entscheidet, ob
   * der Schritt damit erledigt wird (z. B. erst beim ersten Upload).
   */
  onUploaded?: () => void;
  /**
   * Button-Label — Default „Hochladen". Beim Nachladen wird oft „Weitere Datei"
   * sinnvoller sein.
   */
  buttonLabel?: string;
}

interface UploadJob {
  id: number;
  file: File;
  status: 'pending' | 'presign' | 'upload' | 'commit' | 'done' | 'error';
  error?: string;
}

let JOB_COUNTER = 0;

/**
 * Multi-File-Upload für DOCUMENT_UPLOAD-Workflow-Schritte.
 *
 * - File-Input mit `multiple` — Dateien werden seriell hochgeladen
 *   (vereinfacht Fehler-Handling, ClamAV-Scan ist die Bottleneck)
 * - Jede Datei landet als eigenes `Document` mit `workflowItemId`
 * - `onUploaded` wird bei jedem erfolgreichen Upload aufgerufen — der Aufrufer
 *   markiert das Item gewöhnlich nach dem ersten Upload als erledigt, lässt
 *   aber weitere Uploads zu (Nachreichen).
 */
export function WorkflowUploadButton({
  itemId,
  clientId,
  itemTitle,
  expectedClassification,
  onUploaded,
  buttonLabel = 'Hochladen',
}: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [isPending, start] = useTransition();
  const commitDocument = useDocumentCommit();
  const classLabel =
    DOCUMENT_CLASSIFICATION_LABELS[expectedClassification] ?? expectedClassification;
  const gobdRetentionYears = expectedClassification === 'GOBD_INVOICE' ? 8 : 10;
  const allDone = jobs.length > 0 && jobs.every((j) => j.status === 'done' || j.status === 'error');

  function close() {
    if (isPending) return;
    setJobs([]);
    setOpen(false);
  }

  function onFilesPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    const newJobs: UploadJob[] = Array.from(files).map((f) => ({
      id: ++JOB_COUNTER,
      file: f,
      status: 'pending' as const,
    }));
    setJobs((j) => [...j, ...newJobs]);
  }

  function patchJob(id: number, patch: Partial<UploadJob>) {
    setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  async function uploadOne(job: UploadJob): Promise<void> {
    try {
      // Ein POST: Datei + Felder als multipart, App streamt intern.
      patchJob(job.id, { status: 'upload' });
      const fd = new FormData();
      fd.set('file', job.file);
      fd.set('classification', expectedClassification);
      fd.set('title', job.file.name.replace(/\.[^.]+$/, ''));
      fd.set('mimeType', job.file.type || 'application/octet-stream');
      fd.set('clientId', clientId);
      fd.set('workflowItemId', itemId);

      patchJob(job.id, { status: 'commit' });
      await commitDocument(fd);
      patchJob(job.id, { status: 'done' });
      onUploaded?.();
    } catch (err) {
      patchJob(job.id, { status: 'error', error: (err as Error).message });
    }
  }

  function runUploads() {
    const pending = jobs.filter((j) => j.status === 'pending');
    if (pending.length === 0) return;
    start(async () => {
      for (const j of pending) {
        await uploadOne(j);
      }
    });
  }

  const modal = open ? (
    <div className="modal-overlay" onClick={close}>
      <div className="w-full max-w-lg card p-5 relative" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={close}
          className="modal-close"
          aria-label="Schließen"
          disabled={isPending}
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="text-base font-semibold text-primary mb-1">Dokumente hochladen</h2>
        <p className="text-xs text-muted mb-4">
          Workflow-Schritt „{itemTitle}" · Klasse{' '}
          <span className="font-medium text-secondary">{classLabel}</span>
          {expectedClassification.startsWith('GOBD_') && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400 mt-0.5">
              Object-Lock COMPLIANCE — {gobdRetentionYears} Jahre unveränderbar
            </span>
          )}
        </p>

        <div className="space-y-3">
          <div>
            <label className="label" htmlFor={`wf-up-${itemId}`}>
              Dateien wählen
            </label>
            <input
              id={`wf-up-${itemId}`}
              type="file"
              multiple
              className="input"
              onChange={(e) => onFilesPicked(e.target.files)}
              disabled={isPending}
            />
            <p className="text-[10px] text-muted mt-1">
              Mehrfach-Auswahl möglich. Pro Datei entsteht ein eigenes Dokument.
            </p>
          </div>

          {jobs.length > 0 && (
            <ul className="divide-y divide-border-subtle max-h-60 overflow-y-auto">
              {jobs.map((j) => (
                <li key={j.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                  <span className="truncate flex-1 text-secondary">
                    {j.file.name}
                    <span className="text-disabled ml-2">
                      ({(j.file.size / 1024).toFixed(0)} KB)
                    </span>
                  </span>
                  <span className="shrink-0">
                    {j.status === 'pending' && <span className="text-disabled">wartet</span>}
                    {j.status === 'presign' && <span className="text-blue-600">vorbereiten…</span>}
                    {j.status === 'upload' && <span className="text-blue-600">hochladen…</span>}
                    {j.status === 'commit' && <span className="text-blue-600">prüfen…</span>}
                    {j.status === 'done' && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> fertig
                      </span>
                    )}
                    {j.status === 'error' && (
                      <span
                        className="inline-flex items-center gap-1 text-red-700 dark:text-red-400"
                        title={j.error}
                      >
                        <AlertCircle className="h-3 w-3" /> Fehler
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={close}
              disabled={isPending}
              className="btn-secondary flex-1"
            >
              {allDone ? 'Schließen' : 'Abbrechen'}
            </button>
            <button
              type="button"
              onClick={runUploads}
              disabled={isPending || jobs.filter((j) => j.status === 'pending').length === 0}
              className="btn-primary flex-1"
            >
              {isPending ? 'Lädt…' : 'Hochladen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary text-xs inline-flex items-center gap-1"
        title={`Dokument hochladen (${classLabel})`}
      >
        <Upload className="h-3 w-3" />
        {buttonLabel}
      </button>
      {mounted && modal ? createPortal(modal, document.body) : null}
    </>
  );
}
