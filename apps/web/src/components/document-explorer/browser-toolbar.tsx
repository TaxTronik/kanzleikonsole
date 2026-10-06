'use client';
// =============================================================================
// Werkzeugleiste der Browser-Variante (Review-Befund K-04): Auswahl-Leiste mit
// Sammelaktionen, sonst Suche, Gelöscht-Umschalter, neuer Ordner und Upload.
// =============================================================================

import Link from 'next/link';
import {
  Search,
  FolderPlus,
  Download,
  Trash2,
  FolderInput,
  Tag,
  Share2,
  EyeOff,
} from 'lucide-react';
import { DocumentUploadButton } from '@/components/document-upload-button';
import type { SelectionItem } from './browser-selection';
import type { useBrowserSearch } from './browser-navigation';
import type { BrowserProps } from './types';

export interface BrowserToolbarActions {
  move: () => void;
  download: () => void;
  retag: () => void;
  share: (share: boolean) => void;
  delete: () => void;
  clear: () => void;
  newFolder: () => void;
}

export function BrowserToolbar(props: {
  selection: SelectionItem[];
  onlyFiles: boolean;
  busy: boolean;
  deleted: boolean;
  scope: BrowserProps['scope'];
  currentFolderId: string | null;
  toggleDeletedHref?: string;
  search: ReturnType<typeof useBrowserSearch>;
  actions: BrowserToolbarActions;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      {props.selection.length > 0 ? <SelectionBar {...props} /> : <SearchBar {...props} />}
    </div>
  );
}

/** Auswahl-Leiste: Sammelaktionen für die ausgewählten Einträge. */
function SelectionBar({
  selection,
  onlyFiles,
  busy,
  deleted,
  scope,
  actions,
}: Parameters<typeof BrowserToolbar>[0]) {
  return (
    <>
      <span className="text-sm font-medium text-secondary">{selection.length} ausgewählt</span>
      <button
        type="button"
        onClick={actions.move}
        disabled={busy}
        className="btn-secondary text-xs py-1.5"
      >
        <FolderInput className="h-4 w-4" /> Verschieben
      </button>
      <button type="button" onClick={actions.download} className="btn-secondary text-xs py-1.5">
        <Download className="h-4 w-4" />
        {selection.length > 1 || selection.some((s) => s.kind === 'folder')
          ? 'Als ZIP laden'
          : 'Herunterladen'}
      </button>
      {onlyFiles && !deleted && (
        <button
          type="button"
          onClick={actions.retag}
          disabled={busy}
          className="btn-secondary text-xs py-1.5"
        >
          <Tag className="h-4 w-4" /> Typ ändern
        </button>
      )}
      {scope?.clientId && onlyFiles && !deleted && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.share(true)}
            className="btn-secondary text-xs py-1.5 !text-green-700"
          >
            <Share2 className="h-4 w-4" /> Freigeben
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => actions.share(false)}
            className="btn-secondary text-xs py-1.5"
          >
            <EyeOff className="h-4 w-4" /> Privat
          </button>
        </>
      )}
      {onlyFiles && !deleted && (
        <button
          type="button"
          disabled={busy}
          onClick={actions.delete}
          className="btn-secondary text-xs py-1.5 !text-red-600"
        >
          <Trash2 className="h-4 w-4" /> Löschen
        </button>
      )}
      <button
        type="button"
        onClick={actions.clear}
        className="text-xs text-muted hover:text-secondary"
      >
        Aufheben
      </button>
    </>
  );
}

/** Ohne Auswahl: Suche in der Ebene, Gelöscht-Umschalter, neuer Ordner, Upload. */
function SearchBar({
  busy,
  deleted,
  scope,
  currentFolderId,
  toggleDeletedHref,
  search,
  actions,
}: Parameters<typeof BrowserToolbar>[0]) {
  return (
    <>
      <form onSubmit={search.submit} className="relative flex-1 min-w-[220px]">
        <Search className="h-4 w-4 text-disabled absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={search.search}
          onChange={(e) => search.setSearch(e.target.value)}
          placeholder="In diesem Ordner suchen…"
          className="input pl-9"
        />
      </form>
      {scope && (
        <>
          {toggleDeletedHref && (
            <Link
              href={toggleDeletedHref}
              className={`text-xs px-3 py-1.5 rounded ${deleted ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-secondary'}`}
            >
              {deleted ? 'Gelöschte (an)' : 'Gelöschte zeigen'}
            </Link>
          )}
          <button
            type="button"
            onClick={actions.newFolder}
            disabled={busy}
            className="btn-secondary text-xs py-1.5"
          >
            <FolderPlus className="h-4 w-4" /> Neuer Ordner
          </button>
          {!deleted && (
            <DocumentUploadButton
              clientId={scope.clientId ?? undefined}
              folderId={currentFolderId ?? undefined}
              buttonLabel="Hochladen"
              buttonClassName="btn-primary text-xs py-1.5"
            />
          )}
        </>
      )}
    </>
  );
}
