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

import type { Crumb, Entry, FolderNode } from '@/components/document-browser-utils';

export type { Crumb, Entry, FolderNode };

/** Dokument-Zeile für den Embedded-Modus (siehe toManagedDoc in managed-docs). */
export interface ManagedDoc {
  id: string;
  title: string;
  classification: string;
  typeName: string;
  typeId: string | null;
  tier: 'NONE' | 'GWG' | 'GOBD';
  sizeBytes: number;
  createdAt: string;
  folderId: string | null;
  deletedAt: string | null;
  shared: boolean;
}

export interface BrowserProps {
  variant: 'browser';
  crumbs: Crumb[];
  entries: Entry[];
  scope: { clientId: string | null; typeParam: string } | null;
  folders: FolderNode[];
  currentFolderId: string | null;
  deleted: boolean;
  q: string;
  toggleDeletedHref?: string;
  /** P-3: Server hat die Dokumentliste gecappt — Hinweis anzeigen. */
  truncated?: boolean;
  totalCount?: number;
}
export interface EmbeddedProps {
  variant: 'embedded';
  clientId: string | null;
  folders: FolderNode[];
  documents: ManagedDoc[];
  scopeLabel: string;
  canUpload?: boolean;
  /** Sachverhalts-Bezug — Uploads aus dem Aktenregal-Tab setzen analysis_id. */
  analysisId?: string;
  /** P-3: Server hat die Dokumentliste gecappt — Hinweis anzeigen. */
  truncated?: boolean;
  totalCount?: number;
  /** Serverseitig paginierte Aktiv-/Gelöscht-Ansicht. */
  serverDeleted?: {
    showDeleted: boolean;
    activeHref: string;
    deletedHref: string;
  };
}
