'use client';
// =============================================================================
// Gemeinsamer Lösch-Dialog des DocumentExplorer (Browser- und Embedded-
// Variante, Einzel- und Mehrfachauswahl): Soft-Delete MIT optionalem Grund und
// GoBD-/GwG-Aufklärung. Zugriffsprüfung, GwG-Sperre und Audit-Event
// `document.delete` (inkl. Grund) bleiben in softDeleteDocumentAction.
// =============================================================================

import { useState, useTransition } from 'react';
import { softDeleteDocumentAction } from '@/app/staff/(protected)/documents/actions';
import { Modal } from '@/components/ui/modal';
import { runChunked } from '@/components/document-browser-utils';

export interface DeletableDocument {
  id: string;
  title: string;
  classification: string;
}

type SoftDelete = (input: {
  documentId: string;
  reason?: string;
}) => Promise<{ ok: boolean; error?: string }>;

/** Löscht die Auswahl begrenzt parallel mit demselben Grund; Fehler gesammelt. */
export async function softDeleteDocuments(
  docs: readonly DeletableDocument[],
  reason: string,
  softDelete: SoftDelete = softDeleteDocumentAction,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = reason.trim() || undefined;
  const errors = await runChunked([...docs], async (doc) => {
    const result = await softDelete({ documentId: doc.id, reason: trimmed });
    return result.ok ? null : (result.error ?? 'Fehler.');
  });
  if (errors.length === 0) return { ok: true };
  if (docs.length === 1) return { ok: false, error: errors[0] ?? 'Fehler.' };
  return {
    ok: false,
    error: `${docs.length - errors.length} gelöscht, ${errors.length} abgelehnt:\n${[...new Set(errors)].join('\n')}`,
  };
}

/** Aufbewahrungshinweis passend zu den Klassifikationen der Auswahl. */
export function retentionNotes(docs: readonly DeletableDocument[]): string[] {
  const notes: string[] = [];
  if (docs.some((doc) => doc.classification.startsWith('GOBD_'))) {
    notes.push('Der COMPLIANCE-Lock bewahrt GoBD-Belege bis zum hinterlegten Fristende auf.');
  }
  if (docs.some((doc) => doc.classification === 'GWG_EVIDENCE')) {
    notes.push('Die endgültige GwG-Vernichtung erfolgt ausschließlich über die Fristenprüfung.');
  }
  if (notes.length === 0) notes.push('Dieser Vorgang entfernt die gespeicherten Bytes nicht.');
  return notes;
}

interface DeleteDocumentsProps {
  docs: readonly DeletableDocument[];
  onClose: () => void;
  /** Alles gelöscht: Dialog schließen, Liste neu laden. */
  onDone: () => void;
  /** Teilweise gelöscht (Mehrfachauswahl): Liste neu laden, Fehler bleibt sichtbar. */
  onChanged?: () => void;
}

/** Dialoginhalt (ohne Modal-Portal, damit serverseitig renderbar und testbar). */
export function DeleteDocumentsPanel({ docs, onClose, onDone, onChanged }: DeleteDocumentsProps) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const single = docs.length === 1 ? docs[0] : undefined;
  return (
    <>
      <h2 className="text-lg font-semibold text-primary mb-2">
        {single ? 'Dokument löschen' : `${docs.length} Dokumente löschen`}
      </h2>
      <p className="text-sm text-secondary mb-3">
        {single
          ? `„${single.title}" wird aus den Listen ausgeblendet.`
          : 'Die ausgewählten Dokumente werden aus den Listen ausgeblendet.'}
      </p>
      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-4">
        {single ? 'Die Datei wird' : 'Die Dateien werden'} hier nur aus den Listen ausgeblendet.{' '}
        {retentionNotes(docs).join(' ')} Protokolliert im Audit-Log, wiederherstellbar.
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={500}
        className="input mb-3"
        placeholder="Grund (optional)"
        aria-label="Grund der Löschung (optional)"
      />
      {err && (
        <div className="whitespace-pre-line rounded bg-red-50 p-2 text-xs text-red-700 mb-3">
          {err}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setErr(null);
              const result = await softDeleteDocuments(docs, reason);
              if (result.ok) {
                onDone();
                return;
              }
              setErr(result.error);
              if (docs.length > 1) onChanged?.();
            })
          }
          className="btn-primary flex-1 !bg-red-600 hover:!bg-red-700"
        >
          {busy ? 'Löscht…' : 'Löschen'}
        </button>
      </div>
    </>
  );
}

export function DeleteDocumentsDialog(props: DeleteDocumentsProps) {
  return (
    <Modal title="Dokument löschen" onClose={props.onClose}>
      <DeleteDocumentsPanel {...props} />
    </Modal>
  );
}
