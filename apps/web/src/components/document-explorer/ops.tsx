'use client';
// =============================================================================
// DocumentExplorer — DIE Dokumentenverwaltung (konsolidiert aus den früheren
// Komponenten DocumentBrowser + DocumentsManager).
//
// Aufgeteilt aus einer 1547-Zeilen-Datei — rein mechanisch:
//   index.tsx         Weiche browser/embedded + öffentliche Typen
//   types.ts          ManagedDoc, BrowserProps, EmbeddedProps
//   ops.tsx           useDocumentOps + geteilte Dialoge/Badges beider Varianten
//   browser-view.tsx  /staff/documents (URL-getrieben, Explorer-Stil)
//   embedded-view.tsx Mandanten-Tab + Aktenregal (lokal gefiltert, Tabelle)
// =============================================================================

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X, Share2, EyeOff } from 'lucide-react';
import { DocumentPreviewModal } from '@/components/document-preview';
import { RetagDialog } from '@/components/document-dialogs';
import { ConfirmModal, InputModal } from '@/components/ui/modal';
import {
  restoreDocumentAction,
  setDocumentShareAction,
} from '@/app/staff/(protected)/documents/actions';
import {
  createFolderAction,
  renameFolderAction,
} from '@/app/staff/(protected)/documents/folder-actions';

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  danger?: boolean;
  action: () => Promise<{ ok: boolean; error?: string }>;
}
interface RetagState {
  ids: string[];
  title: string;
  /** Nur bei Einzel-Dokument — sperrt Herabstufungen clientseitig. */
  tier?: 'NONE' | 'GWG' | 'GOBD';
  typeId?: string | null;
  onDone?: () => void;
}
interface CreateFolderState {
  parentId: string | null;
  title: string;
  placeholder: string;
}

export function useDocumentOps() {
  const router = useRouter();
  const [busy, start] = useTransition();
  // Sammel-Fehlermeldung für Hintergrund-Operationen (statt window.alert).
  const [opError, setOpError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string } | null>(null);
  const [retag, setRetag] = useState<RetagState | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [createFolder, setCreateFolder] = useState<CreateFolderState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  function toggleShare(id: string, share: boolean) {
    start(async () => {
      setOpError(null);
      const r = await setDocumentShareAction({ documentId: id, share });
      if (!r.ok) setOpError(r.error ?? 'Fehler.');
      else router.refresh();
    });
  }
  function restoreDoc(id: string) {
    start(async () => {
      setOpError(null);
      const r = await restoreDocumentAction({ documentId: id });
      if (!r.ok) setOpError(r.error ?? 'Fehler.');
      else router.refresh();
    });
  }

  return {
    router,
    busy,
    start,
    opError,
    setOpError,
    previewDoc,
    setPreviewDoc,
    retag,
    setRetag,
    renameTarget,
    setRenameTarget,
    createFolder,
    setCreateFolder,
    confirmState,
    setConfirmState,
    toggleShare,
    restoreDoc,
  };
}
export type DocumentOps = ReturnType<typeof useDocumentOps>;

export function OpErrorBanner({ ops }: { ops: DocumentOps }) {
  if (!ops.opError) return null;
  return (
    <div className="alert-error-sm mb-3 flex items-start justify-between gap-3">
      <span className="whitespace-pre-line">{ops.opError}</span>
      <button
        type="button"
        onClick={() => ops.setOpError(null)}
        aria-label="Meldung schließen"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Badge „geteilt"/„privat" an Mandanten-Dokumenten. */
export function ShareBadge({ shared }: { shared: boolean }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
        shared
          ? 'bg-green-50 text-green-700 border-green-200'
          : 'bg-gray-50 text-muted border-default'
      }`}
    >
      {shared ? <Share2 className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
      {shared ? 'geteilt' : 'privat'}
    </span>
  );
}

/** Von beiden Varianten genutzte Dialoge (Zustand in useDocumentOps). */
export function SharedDialogs({
  ops,
  scopeClientId,
}: {
  ops: DocumentOps;
  scopeClientId: string | null;
}) {
  const { router } = ops;
  return (
    <>
      {ops.retag && (
        <RetagDialog
          documentIds={ops.retag.ids}
          documentTitle={ops.retag.title}
          currentTier={ops.retag.tier}
          currentTypeId={ops.retag.typeId}
          onClose={() => ops.setRetag(null)}
          onDone={() => {
            const cb = ops.retag?.onDone;
            ops.setRetag(null);
            cb?.();
            router.refresh();
          }}
        />
      )}
      {ops.previewDoc && (
        <DocumentPreviewModal
          documentId={ops.previewDoc.id}
          documentTitle={ops.previewDoc.name}
          onClose={() => ops.setPreviewDoc(null)}
        />
      )}
      {ops.createFolder && (
        <InputModal
          title={ops.createFolder.title}
          placeholder={ops.createFolder.placeholder}
          confirmLabel="Anlegen"
          busyLabel="Legt an…"
          onSubmit={async (name) => {
            const r = await createFolderAction({
              clientId: scopeClientId,
              parentId: ops.createFolder!.parentId,
              name,
            });
            if (r.ok) router.refresh();
            return r;
          }}
          onClose={() => ops.setCreateFolder(null)}
        />
      )}
      {ops.renameTarget && (
        <InputModal
          title="Ordner umbenennen"
          initialValue={ops.renameTarget.name}
          onSubmit={async (name) => {
            const r = await renameFolderAction({ folderId: ops.renameTarget!.id, name });
            if (r.ok) router.refresh();
            return r;
          }}
          onClose={() => ops.setRenameTarget(null)}
        />
      )}
      {ops.confirmState && (
        <ConfirmModal
          title={ops.confirmState.title}
          message={ops.confirmState.message}
          confirmLabel={ops.confirmState.confirmLabel}
          busyLabel={ops.confirmState.busyLabel}
          danger={ops.confirmState.danger}
          onConfirm={ops.confirmState.action}
          onClose={() => ops.setConfirmState(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Öffentliche Komponente
// ---------------------------------------------------------------------------

/** P-3: Hinweis, wenn der Server die Dokumentliste gecappt hat. */
export function TruncationHint({ shown, totalCount }: { shown: number; totalCount?: number }) {
  return (
    <p className="mb-2 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-100">
      Zeige die neuesten {shown.toLocaleString('de-DE')} Dokumente
      {totalCount ? ` von ${totalCount.toLocaleString('de-DE')}` : ''} — ältere bitte über Ordner
      oder Suche eingrenzen.
    </p>
  );
}
