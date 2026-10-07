'use client';
// =============================================================================
// Gemeinsamer Lösch-Dialog des DocumentExplorer (Browser- und Embedded-
// Variante, Einzel- und Mehrfachauswahl): Soft-Delete MIT optionalem Grund und
// GoBD-/GwG-Aufklärung. Zugriffsprüfung, GwG-Sperre und Audit-Event
// `document.delete` (inkl. Grund) je Dokument bleiben serverseitig in
// softDeleteDocumentsAction (P-18: eine Action für die ganze Auswahl).
// =============================================================================

import { useState, useTransition } from 'react';
import { documentTier, type ProtectionTier } from '@taxtronik/storage/tiers';
import { softDeleteDocumentsAction } from '@/app/staff/(protected)/documents/actions';
import { Modal } from '@/components/ui/modal';
import { bulkResultMessage } from '@/components/document-browser-utils';
import type { DocumentBulkResult } from '@/server/documents/document-bulk';

export interface DeletableDocument {
  id: string;
  title: string;
  classification: string;
  /** Schutzstufe des Dokumenttyps (ManagedDoc.tier); ohne Typ gilt die Klassifikation. */
  tier?: ProtectionTier | null;
}

type SoftDeleteMany = (input: {
  documentIds: string[];
  reason?: string;
}) => Promise<DocumentBulkResult>;

/** Löscht die Auswahl mit einem Aufruf und demselben Grund; Ablehnungen gesammelt. */
export async function softDeleteDocuments(
  docs: readonly DeletableDocument[],
  reason: string,
  softDeleteMany: SoftDeleteMany = softDeleteDocumentsAction,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await softDeleteMany({
    documentIds: docs.map((doc) => doc.id),
    reason: reason.trim() || undefined,
  });
  const error = bulkResultMessage(result, docs.length, 'gelöscht');
  return error ? { ok: false, error } : { ok: true };
}

/**
 * Aufbewahrungshinweis passend zu den Schutzstufen der Auswahl. R-14: dieselbe
 * Stufenregel wie Explorer, Detailseite und Storage (documentTier) statt eines
 * Namenspräfixes der Klassifikation.
 */
export function retentionNotes(docs: readonly DeletableDocument[]): string[] {
  const tiers = new Set(docs.map((doc) => documentTier(doc.classification, doc.tier)));
  const notes: string[] = [];
  if (tiers.has('GOBD')) {
    notes.push('Der COMPLIANCE-Lock bewahrt GoBD-Belege bis zum hinterlegten Fristende auf.');
  }
  if (tiers.has('GWG')) {
    notes.push('Die endgültige GwG-Vernichtung erfolgt ausschließlich über die Fristenprüfung.');
  }
  if (notes.length === 0) notes.push('Dieser Vorgang entfernt die gespeicherten Bytes nicht.');
  return notes;
}

interface DeleteDocumentsProps {
  docs: readonly DeletableDocument[];
  onClose: () => void;
  /**
   * Alles gelöscht: Dialog schließen. Die Liste lädt die Action-Antwort neu
   * (Revalidierung, auch bei Teilerfolg) — kein zusätzlicher Router-Refresh.
   */
  onDone: () => void;
}

/** Dialoginhalt (ohne Modal-Portal, damit serverseitig renderbar und testbar). */
export function DeleteDocumentsPanel({ docs, onClose, onDone }: DeleteDocumentsProps) {
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
