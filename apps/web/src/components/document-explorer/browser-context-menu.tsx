'use client';
// =============================================================================
// Rechtsklick-Menü der Browser-Variante (Review-Befund K-04). Öffnen und
// Details schließen das Menü über den Fenster-Klick (browser-dialogs.ts).
// =============================================================================

import {
  Folder,
  FileText,
  Download,
  RotateCcw,
  Trash2,
  Pencil,
  FolderInput,
  Tag,
} from 'lucide-react';
import { entryLabel } from '@/components/document-browser-utils';
import type { DocumentOps } from './ops';
import type { ContextMenuState } from './browser-dialogs';
import type { FileEntry } from './browser-selection';

export interface BrowserContextMenuActions {
  close: () => void;
  openMove: () => void;
  deleteFolder: (id: string, name: string) => void;
  softDelete: (files: FileEntry[]) => void;
  folderDownloadHref: (folderId: string) => string;
}

export function BrowserContextMenu({
  menu,
  ops,
  actions,
}: {
  menu: ContextMenuState;
  ops: DocumentOps;
  actions: BrowserContextMenuActions;
}) {
  return (
    <div
      role="group"
      aria-label={`Aktionen für ${entryLabel(menu.e)}`}
      className="fixed z-[120] w-48 card py-1 text-sm shadow-lg"
      style={{ top: menu.y, left: menu.x }}
    >
      {menu.e.kind === 'folder' && <FolderMenu menu={menu} ops={ops} actions={actions} />}
      {menu.e.kind === 'file' && <FileMenu menu={menu} ops={ops} actions={actions} />}
    </div>
  );
}

function FolderMenu({
  menu,
  ops,
  actions,
}: {
  menu: ContextMenuState;
  ops: DocumentOps;
  actions: BrowserContextMenuActions;
}) {
  const { router } = ops;
  return (
    <>
      <MenuItem
        icon={Folder}
        label="Öffnen"
        onClick={() => router.push((menu.e as { href: string }).href)}
      />
      <MenuItem
        icon={Download}
        label="Als ZIP laden"
        onClick={() => {
          window.location.href = actions.folderDownloadHref(menu.e.id);
          actions.close();
        }}
      />
      <MenuItem
        icon={Pencil}
        label="Umbenennen"
        onClick={() => {
          ops.setRenameTarget({ id: menu.e.id, name: entryLabel(menu.e) });
          actions.close();
        }}
      />
      <MenuItem
        icon={FolderInput}
        label="Verschieben"
        onClick={() => {
          actions.openMove();
          actions.close();
        }}
      />
      <MenuItem
        icon={Trash2}
        label="Löschen"
        danger
        onClick={() => {
          actions.deleteFolder(menu.e.id, entryLabel(menu.e));
          actions.close();
        }}
      />
    </>
  );
}

function FileMenu({
  menu,
  ops,
  actions,
}: {
  menu: ContextMenuState;
  ops: DocumentOps;
  actions: BrowserContextMenuActions;
}) {
  const { router } = ops;
  const deleted = 'deletedAt' in menu.e && menu.e.deletedAt;
  return (
    <>
      <MenuItem
        icon={FileText}
        label="Details"
        onClick={() => router.push(`/staff/documents/${menu.e.id}`)}
      />
      <MenuItem
        icon={Download}
        label="Herunterladen"
        onClick={() => {
          window.location.href = `/api/staff/documents/${menu.e.id}/download`;
          actions.close();
        }}
      />
      {!deleted && (
        <>
          <MenuItem
            icon={FolderInput}
            label="Verschieben"
            onClick={() => {
              actions.openMove();
              actions.close();
            }}
          />
          <MenuItem
            icon={Tag}
            label="Typ ändern"
            onClick={() => {
              const f = menu.e as FileEntry;
              ops.setRetag({ ids: [f.id], title: f.title, tier: f.tier, typeId: f.typeId });
              actions.close();
            }}
          />
          <MenuItem
            icon={Trash2}
            label="Löschen"
            danger
            onClick={() => {
              actions.softDelete([menu.e as FileEntry]);
              actions.close();
            }}
          />
        </>
      )}
      {deleted && (
        <MenuItem
          icon={RotateCcw}
          label="Wiederherstellen"
          onClick={() => {
            ops.restoreDoc(menu.e.id);
            actions.close();
          }}
        />
      )}
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 hover:bg-gray-50 ${danger ? 'text-red-600 hover:bg-red-50' : 'text-secondary'}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
