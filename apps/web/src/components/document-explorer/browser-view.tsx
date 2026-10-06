'use client';
// =============================================================================
// DocumentExplorer — DIE Dokumentenverwaltung (konsolidiert aus den früheren
// Komponenten DocumentBrowser + DocumentsManager).
//
// Aufgeteilt aus einer 1547-Zeilen-Datei — rein mechanisch:
//   index.tsx         Weiche browser/embedded + öffentliche Typen
//   types.ts          BrowserProps, EmbeddedProps (DTO ManagedDoc: server/documents)
//   ops.tsx           useDocumentOps + geteilte Dialoge/Badges beider Varianten
//   browser-view.tsx  /staff/documents (URL-getrieben, Explorer-Stil)
//   embedded-view.tsx Mandanten-Tab (serverseitig gefiltert) + Aktenregal
//   delete-dialog.tsx Gemeinsamer Lösch-Dialog (mit Grund) beider Varianten
//
// Die Browser-Variante setzt sich nach Zuständigkeit zusammen (K-04):
//   browser-selection.ts   Auswahl und Drag-Nutzlast
//   browser-navigation.ts  Suchentwurf und URL-Ziel
//   browser-dialogs.ts     Verschiebe-/Lösch-Dialog, Rechtsklick-Menü
//   browser-operations.ts  Sammelaktionen (P-18), Downloads, Datei-Drop
//   browser-toolbar.tsx / browser-entry-list.tsx / browser-context-menu.tsx
// =============================================================================

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { MoveTargetDialog } from '@/components/document-dialogs';
import { setDocumentsShareAction } from '@/app/staff/(protected)/documents/actions';
import {
  deleteFolderAction,
  moveDocumentItemsAction,
} from '@/app/staff/(protected)/documents/folder-actions';

import { DeleteDocumentsDialog } from './delete-dialog';
import { OpErrorBanner, TruncationHint, type DocumentOps } from './ops';
import type { BrowserProps } from './types';
import { useBrowserSelection } from './browser-selection';
import { useBrowserSearch } from './browser-navigation';
import { useBrowserDialogs } from './browser-dialogs';
import {
  documentsDownloadUrl,
  useBrowserOperations,
  useOsFileDrop,
  type BrowserActions,
} from './browser-operations';
import { BrowserToolbar } from './browser-toolbar';
import { BrowserEntryList } from './browser-entry-list';
import { BrowserContextMenu } from './browser-context-menu';

// ---------------------------------------------------------------------------
// Variante „browser" — /staff/documents (URL-getrieben, Explorer-Stil)
// ---------------------------------------------------------------------------

/** P-18: eine Action je Auswahl; ihre Antwort rendert die Liste neu. */
const BROWSER_ACTIONS: BrowserActions = {
  moveItems: moveDocumentItemsAction,
  setShare: setDocumentsShareAction,
  deleteFolder: deleteFolderAction,
};

export function BrowserView({
  crumbs,
  entries,
  scope,
  folders,
  currentFolderId,
  deleted,
  q,
  toggleDeletedHref,
  truncated,
  totalCount,
  ops,
}: Omit<BrowserProps, 'variant'> & { ops: DocumentOps }) {
  const { router, busy } = ops;
  const selection = useBrowserSelection(entries);
  const search = useBrowserSearch(q, crumbs, router);
  const dialogs = useBrowserDialogs();
  const operations = useBrowserOperations({
    ops,
    actions: BROWSER_ACTIONS,
    folders,
    scope,
    deleted,
    currentFolderId,
    onMoved: () => {
      selection.clear();
      dialogs.closeMove();
    },
    onShared: selection.clear,
  });
  const osDrop = useOsFileDrop(Boolean(scope) && !deleted, operations.uploadDropped);

  function newFolder() {
    if (!scope) return;
    ops.setCreateFolder({
      parentId: currentFolderId,
      title: 'Neuer Ordner',
      placeholder: 'Name des neuen Ordners',
    });
  }

  return (
    <div
      className="p-8 relative"
      onContextMenu={(e) => {
        if (dialogs.contextMenu) e.preventDefault();
      }}
      {...osDrop.handlers}
    >
      {osDrop.active && scope && !deleted && (
        <div className="absolute inset-4 z-[90] rounded-xl border-2 border-dashed border-brand-400 bg-brand-50/80 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-medium text-brand-700">
            Dateien hier ablegen — Upload in „{crumbs[crumbs.length - 1]?.label}"
          </p>
        </div>
      )}
      {/* Breadcrumb (Ordner-Crumbs sind Drop-Ziele) */}
      <nav className="flex items-center flex-wrap gap-1 text-sm text-muted mb-4">
        {crumbs.map((c, i) => (
          <span key={c.href} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-disabled" />}
            {i === crumbs.length - 1 ? (
              <span className="font-semibold text-primary">{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-brand-700 hover:underline">
                {c.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {/* Toolbar / Auswahl-Leiste */}
      <BrowserToolbar
        selection={selection.selection}
        onlyFiles={selection.onlyFiles}
        busy={busy}
        deleted={deleted}
        scope={scope}
        currentFolderId={currentFolderId}
        toggleDeletedHref={toggleDeletedHref}
        search={search}
        actions={{
          move: dialogs.openMove,
          download: () => {
            window.location.href = documentsDownloadUrl(selection.fileIds(), selection.folderIds());
          },
          retag: () => {
            const ids = selection.fileIds();
            ops.setRetag({ ids, title: `${ids.length} Dokument(e)`, onDone: selection.clear });
          },
          share: (share) => operations.bulkShare(selection.fileIds(), share),
          delete: () => dialogs.softDelete(selection.selectedFiles()),
          clear: selection.clear,
          newFolder,
        }}
      />

      <OpErrorBanner ops={ops} />

      {truncated && (
        <TruncationHint
          shown={entries.filter((e) => e.kind === 'file').length}
          totalCount={totalCount}
        />
      )}

      <BrowserEntryList
        entries={entries}
        scope={scope}
        currentFolderId={currentFolderId}
        deleted={deleted}
        busy={busy}
        selection={selection}
        ops={ops}
        handlers={{
          dropInto: operations.dropInto,
          openContextMenu: (entry, x, y) => dialogs.openContextMenu({ x, y, e: entry }),
          moveFile: (id) => {
            selection.selectOnly('file', id);
            dialogs.openMove();
          },
          deleteFile: (file) => dialogs.softDelete([file]),
          folderDownloadHref: (folderId) => documentsDownloadUrl([], [folderId]),
        }}
      />

      {/* Rechtsklick-Menü */}
      {dialogs.contextMenu && (
        <BrowserContextMenu
          menu={dialogs.contextMenu}
          ops={ops}
          actions={{
            close: dialogs.closeContextMenu,
            openMove: dialogs.openMove,
            deleteFolder: operations.deleteFolder,
            softDelete: dialogs.softDelete,
            folderDownloadHref: (folderId) => documentsDownloadUrl([], [folderId]),
          }}
        />
      )}

      {dialogs.deleteDocs && (
        <DeleteDocumentsDialog
          docs={dialogs.deleteDocs}
          onClose={dialogs.closeDelete}
          onDone={() => {
            dialogs.closeDelete();
            selection.clear();
          }}
        />
      )}
      {dialogs.moveOpen && (
        <MoveTargetDialog
          folders={folders}
          movingFolderIds={selection.folderIds()}
          onClose={dialogs.closeMove}
          onPick={(target) => operations.moveSet(selection.selection, target)}
        />
      )}
    </div>
  );
}
