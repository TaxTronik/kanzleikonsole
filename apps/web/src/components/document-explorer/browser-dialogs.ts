'use client';
// =============================================================================
// Dialog- und Menüzustand der Browser-Variante (Review-Befund K-04):
// Verschiebe-Dialog, gemeinsamer Lösch-Dialog (mit Grund) und Rechtsklick-
// Menü. Das Menü schließt bei jedem Klick und jedem Scrollen im Fenster.
// =============================================================================

import { useEffect, useState } from 'react';
import type { Entry } from '@/components/document-browser-utils';
import type { DeletableDocument } from './delete-dialog';

export interface ContextMenuState {
  x: number;
  y: number;
  e: Entry;
}

export function useBrowserDialogs() {
  const [moveOpen, setMoveOpen] = useState(false);
  const [deleteDocs, setDeleteDocs] = useState<DeletableDocument[] | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  return {
    moveOpen,
    openMove: () => setMoveOpen(true),
    closeMove: () => setMoveOpen(false),
    deleteDocs,
    /** Gemeinsamer Lösch-Dialog — einzeln wie für die Auswahl. */
    softDelete: (files: DeletableDocument[]) => {
      if (files.length > 0) setDeleteDocs(files);
    },
    closeDelete: () => setDeleteDocs(null),
    contextMenu,
    openContextMenu: (state: ContextMenuState) => setContextMenu(state),
    closeContextMenu: () => setContextMenu(null),
  };
}
export type BrowserDialogs = ReturnType<typeof useBrowserDialogs>;
