'use client';
// =============================================================================
// Eintragsliste der Browser-Variante (Review-Befund K-04): Ablagefläche „eine
// Ebene hoch“, Zeilen für Bereiche, Ordner und Dateien mit Auswahl,
// Drag & Drop (Ordner sind Ablageziele), Rechtsklick und Zeilenaktionen.
// =============================================================================

import { useState, type MouseEvent } from 'react';
import Link from 'next/link';
import {
  Folder,
  Download,
  RotateCcw,
  Trash2,
  FolderInput,
  Tag,
  CornerLeftUp,
  Share2,
  EyeOff,
  type LucideIcon,
} from 'lucide-react';
import {
  TIER_BADGE,
  fileIcon,
  fmtBytes,
  fmtDate,
  navIcon,
  type Entry,
} from '@/components/document-browser-utils';
import { ShareBadge, type DocumentOps } from './ops';
import type { BrowserSelection, FileEntry } from './browser-selection';
import type { BrowserProps } from './types';

type DropTarget = string | 'root' | null;

export interface BrowserEntryHandlers {
  /** Interne Drag-Nutzlast in einen Ordner (null = Wurzel des Bereichs) verschieben. */
  dropInto: (target: string | null, payloadRaw: string) => void;
  /** Rechtsklick auf einen Ordner oder eine Datei. */
  openContextMenu: (entry: Entry, x: number, y: number) => void;
  /** Zeilenbefehl „Verschieben“: genau diese Datei. */
  moveFile: (id: string) => void;
  deleteFile: (file: FileEntry) => void;
  folderDownloadHref: (folderId: string) => string;
}

export function BrowserEntryList({
  entries,
  scope,
  currentFolderId,
  deleted,
  busy,
  selection,
  ops,
  handlers,
}: {
  entries: Entry[];
  scope: BrowserProps['scope'];
  currentFolderId: string | null;
  deleted: boolean;
  busy: boolean;
  selection: BrowserSelection;
  ops: DocumentOps;
  handlers: BrowserEntryHandlers;
}) {
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  return (
    <>
      {/* „Eine Ebene hoch" als Drop-Ziel (Wurzel des Scopes) */}
      {scope && currentFolderId && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget('root');
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            setDropTarget(null);
            handlers.dropInto(null, e.dataTransfer.getData('text/plain'));
          }}
          className={`mb-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs ${
            dropTarget === 'root'
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-default text-disabled'
          }`}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
          Hierher ziehen = aus Ordner herauslösen (Wurzel)
        </div>
      )}

      {/* Liste */}
      {entries.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <Folder className="h-12 w-12 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">
            {deleted ? 'Keine gelöschten Dokumente hier.' : 'Dieser Ordner ist leer.'}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-border-subtle">
          {entries.map((e) => (
            <BrowserEntryRow
              key={`${e.kind}-${e.id}`}
              entry={e}
              scope={scope}
              busy={busy}
              selected={e.kind !== 'nav' && selection.isSelected(e.kind, e.id)}
              isDropTarget={e.kind === 'folder' && dropTarget === e.id}
              setDropTarget={setDropTarget}
              selection={selection}
              ops={ops}
              handlers={handlers}
            />
          ))}
        </div>
      )}
    </>
  );
}

function BrowserEntryRow({
  entry: e,
  scope,
  busy,
  selected,
  isDropTarget,
  setDropTarget,
  selection,
  ops,
  handlers,
}: {
  entry: Entry;
  scope: BrowserProps['scope'];
  busy: boolean;
  selected: boolean;
  isDropTarget: boolean;
  setDropTarget: (target: DropTarget) => void;
  selection: BrowserSelection;
  ops: DocumentOps;
  handlers: BrowserEntryHandlers;
}) {
  const selectable = e.kind !== 'nav';
  const folderId = e.kind === 'folder' ? e.id : null;
  function onContextMenu(ev: MouseEvent<HTMLDivElement>) {
    if (e.kind === 'nav') return;
    ev.preventDefault();
    if (!selection.isSelected(e.kind, e.id)) selection.selectOnly(e.kind, e.id);
    handlers.openContextMenu(e, ev.clientX, ev.clientY);
  }
  return (
    <div
      data-document-id={e.kind === 'file' ? e.id : undefined}
      draggable={selectable}
      onDragStart={(ev) => {
        const p = selection.dragPayload(e);
        ev.dataTransfer.setData('text/plain', JSON.stringify(p));
        ev.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={
        folderId
          ? (ev) => {
              ev.preventDefault();
              setDropTarget(folderId);
            }
          : undefined
      }
      onDragLeave={folderId ? () => setDropTarget(null) : undefined}
      onDrop={
        folderId
          ? (ev) => {
              ev.preventDefault();
              setDropTarget(null);
              handlers.dropInto(folderId, ev.dataTransfer.getData('text/plain'));
            }
          : undefined
      }
      onContextMenu={onContextMenu}
      className={`flex items-center gap-3 px-5 py-3 group ${
        isDropTarget
          ? 'bg-brand-50 ring-1 ring-inset ring-brand-300'
          : selected
            ? 'bg-brand-50/60'
            : 'hover:bg-gray-50'
      }`}
    >
      {e.kind !== 'nav' && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => selection.toggle(e.kind, e.id)}
          className="shrink-0"
          aria-label="Auswählen"
        />
      )}
      {e.kind === 'file' ? (
        <FileTitle file={e} scope={scope} ops={ops} />
      ) : (
        <Link href={e.href} className="flex items-center gap-3 flex-1 min-w-0">
          <EntryIcon
            icon={e.kind === 'folder' ? Folder : navIcon(e.icon)}
            className="h-5 w-5 text-brand-600 shrink-0"
          />
          <span className="font-medium text-primary truncate">{e.name}</span>
        </Link>
      )}
      {e.kind === 'file' && (
        <FileRowActions file={e} scope={scope} busy={busy} ops={ops} handlers={handlers} />
      )}
      {e.kind === 'folder' && (
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
          <a
            href={handlers.folderDownloadHref(e.id)}
            className="text-disabled hover:text-primary p-1.5 inline-flex items-center"
            title="Ordner als ZIP herunterladen"
          >
            <Download className="h-4 w-4" />
          </a>
        </div>
      )}
    </div>
  );
}

/** Symbol eines Eintrags; die Komponente kommt aus der statischen Zuordnung (fileIcon/navIcon). */
function EntryIcon({ icon: Icon, className }: { icon: LucideIcon; className: string }) {
  return <Icon className={className} />;
}

function FileTitle({
  file: e,
  scope,
  ops,
}: {
  file: FileEntry;
  scope: BrowserProps['scope'];
  ops: DocumentOps;
}) {
  return (
    <button
      type="button"
      onClick={() => ops.setPreviewDoc({ id: e.id, name: e.title })}
      className="flex items-center gap-3 flex-1 min-w-0 text-left"
      title="Vorschau öffnen"
    >
      <EntryIcon icon={fileIcon(e.mimeType)} className="h-5 w-5 text-disabled shrink-0" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-primary truncate hover:underline">{e.title}</span>
          {e.tier !== 'NONE' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                e.tier === 'GOBD'
                  ? 'bg-red-50 text-red-700 border-red-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              {TIER_BADGE[e.tier]}
            </span>
          )}
          {scope?.clientId && !e.deletedAt && <ShareBadge shared={e.shared} />}
        </div>
        <div className="text-xs text-disabled truncate">
          {e.typeName || '—'} · {fmtBytes(e.sizeBytes)} ·{' '}
          {e.deletedAt ? `gelöscht ${fmtDate(e.deletedAt)}` : fmtDate(e.createdAt)}
        </div>
      </div>
    </button>
  );
}

function FileRowActions({
  file: e,
  scope,
  busy,
  ops,
  handlers,
}: {
  file: FileEntry;
  scope: BrowserProps['scope'];
  busy: boolean;
  ops: DocumentOps;
  handlers: BrowserEntryHandlers;
}) {
  return (
    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
      <a
        href={`/api/staff/documents/${e.id}/download`}
        className="text-disabled hover:text-primary p-1.5 inline-flex items-center"
        title="Herunterladen"
      >
        <Download className="h-4 w-4" />
      </a>
      {e.deletedAt ? (
        <button
          type="button"
          disabled={busy}
          title="Wiederherstellen"
          onClick={() => ops.restoreDoc(e.id)}
          className="icon-btn"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      ) : (
        <>
          {scope?.clientId && (
            <button
              type="button"
              disabled={busy}
              title={e.shared ? 'Freigabe für Mandant zurückziehen' : 'Für Mandant freigeben'}
              onClick={() => ops.toggleShare(e.id, !e.shared)}
              className={`p-1.5 ${e.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
            >
              {e.shared ? <Share2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
          )}
          <button
            type="button"
            title="Typ ändern"
            onClick={() =>
              ops.setRetag({
                ids: [e.id],
                title: e.title,
                tier: e.tier,
                typeId: e.typeId,
              })
            }
            className="icon-btn"
          >
            <Tag className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Verschieben"
            onClick={() => handlers.moveFile(e.id)}
            className="icon-btn"
          >
            <FolderInput className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Löschen"
            disabled={busy}
            onClick={() => handlers.deleteFile(e)}
            className="text-disabled hover:text-red-600 p-1.5"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
