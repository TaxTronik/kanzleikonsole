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
// =============================================================================

import type { Crumb, Entry, FolderNode } from '@/components/document-browser-utils';
import type { ManagedDoc } from '@/server/documents/managed-docs';

export type { Crumb, Entry, FolderNode, ManagedDoc };

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
  /**
   * Serverseitige Ordner-/Suchfilterung über ALLE Dokumente des Bereichs (statt
   * nur über die geladene Seite). Ohne diesen Block filtert die Ansicht lokal
   * (Aktenregal: vollständige, ungeblätterte Liste).
   */
  serverFilter?: EmbeddedServerFilter;
}

export interface EmbeddedServerFilter {
  /** 'all' | 'none' | Ordner-ID */
  folder: string;
  q: string;
  /** Dokumente je Ordner inkl. Unterordnern über den gesamten Bereich. */
  counts: { all: number; none: number; byId: Record<string, number> };
  /** Ziel je Ordnerauswahl ('all' | 'none' | Ordner-ID), jeweils Seite 1. */
  folderHrefs: Record<string, string>;
  /** Ziel der Suche ohne Suchbegriff; `searchParam` trägt den Begriff. */
  searchHref: string;
  searchParam: string;
}
