'use client';
// =============================================================================
// Sammel- und Dateioperationen der Browser-Variante (Review-Befund K-04):
// Verschieben (Dialog und Drag & Drop), Freigeben/Privat, Ordner löschen,
// ZIP-Download und Upload per Datei-Drop aus dem Betriebssystem.
//
// P-18: Verschieben und Freigeben laufen als EINE Server-Action für die ganze
// Auswahl; ihre Antwort rendert die Liste neu (kein zusätzlicher
// Router-Refresh), Ablehnungen erscheinen gesammelt. Die Actions kommen als
// Parameter aus browser-view.tsx (Schichtgrenze K-08: components/ importiert
// nicht aus app/).
// =============================================================================

import { useState, type DragEvent } from 'react';
import {
  bulkResultMessage,
  descendants,
  type FolderNode,
} from '@/components/document-browser-utils';
import type { DocumentBulkResult } from '@/server/documents/document-bulk';
import type { DocumentOps } from './ops';
import type { SelectionItem } from './browser-selection';
import type { BrowserProps } from './types';

export interface BrowserActions {
  moveItems: (input: {
    documentIds: string[];
    folderIds: string[];
    targetFolderId: string | null;
  }) => Promise<DocumentBulkResult>;
  setShare: (input: { documentIds: string[]; share: boolean }) => Promise<DocumentBulkResult>;
  deleteFolder: (input: { folderId: string }) => Promise<{ ok: boolean; error?: string }>;
}

const OWN_SUBTREE_ERROR = 'Ordner kann nicht in seinen eigenen Unterbaum.';

/** Trennt Ordner, die in ihren eigenen Teilbaum wandern würden (der Server prüft erneut). */
export function splitMoveItems(
  items: SelectionItem[],
  target: string | null,
  folders: FolderNode[],
): { movable: SelectionItem[]; blocked: Array<{ id: string; error: string }> } {
  const intoOwnSubtree = (item: SelectionItem) =>
    item.kind === 'folder' && target !== null && descendants(folders, item.id).has(target);
  return {
    movable: items.filter((item) => !intoOwnSubtree(item)),
    blocked: items
      .filter(intoOwnSubtree)
      .map((item) => ({ id: item.id, error: OWN_SUBTREE_ERROR })),
  };
}

/** Download-Ziel für Dateien und Ordner (mehrere oder Ordner: ZIP). */
export function documentsDownloadUrl(fileIds: string[], folderIds: string[]): string {
  const params = new URLSearchParams();
  if (fileIds.length) params.set('ids', fileIds.join(','));
  if (folderIds.length) params.set('folders', folderIds.join(','));
  return `/api/staff/documents/download?${params.toString()}`;
}

/** Standardtyp für Datei-Drops: GENERAL, sonst der erste ohne Schutzstufe, sonst der erste. */
export function defaultDropTypeId(
  types: Array<{ id: string; classificationKey: string | null; tier: string }>,
): string {
  return (
    types.find((type) => type.classificationKey === 'GENERAL')?.id ??
    types.find((type) => type.tier === 'NONE')?.id ??
    types[0]?.id ??
    ''
  );
}

/** Formular eines Datei-Uploads in den geöffneten Bereich/Ordner. */
export function dropUploadFormData(
  file: File,
  typeId: string,
  clientId: string | null,
  folderId: string | null,
): FormData {
  const data = new FormData();
  data.set('file', file);
  data.set('documentTypeId', typeId);
  data.set('title', file.name.replace(/\.[^.]+$/, ''));
  data.set('mimeType', file.type || 'application/octet-stream');
  if (clientId) data.set('clientId', clientId);
  if (folderId) data.set('folderId', folderId);
  return data;
}

/** OS-Datei-Drop (dataTransfer.types enthält 'Files') statt internem Verschieben. */
export function isOsFileDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

export function useBrowserOperations({
  ops,
  actions,
  folders,
  scope,
  deleted,
  currentFolderId,
  onMoved,
  onShared,
}: {
  ops: DocumentOps;
  actions: BrowserActions;
  folders: FolderNode[];
  scope: BrowserProps['scope'];
  deleted: boolean;
  currentFolderId: string | null;
  /** Nach dem Verschieben: Auswahl leeren, Dialog schließen. */
  onMoved: () => void;
  /** Nach Freigeben/Privat: Auswahl leeren. */
  onShared: () => void;
}) {
  const { router, start } = ops;

  // ---- Verschieben (eine Menge → Ziel-Ordner-ID | null=Wurzel) ----
  function moveSet(items: SelectionItem[], target: string | null) {
    if (items.length === 0) return;
    const { movable, blocked } = splitMoveItems(items, target, folders);
    start(async () => {
      ops.setOpError(null);
      const result =
        movable.length > 0
          ? await actions.moveItems({
              documentIds: movable.filter((it) => it.kind === 'file').map((it) => it.id),
              folderIds: movable.filter((it) => it.kind === 'folder').map((it) => it.id),
              targetFolderId: target,
            })
          : { done: 0, rejected: [] };
      const message = bulkResultMessage(
        { ...result, rejected: [...blocked, ...result.rejected] },
        items.length,
        'verschoben',
      );
      if (message) ops.setOpError(message);
      onMoved();
    });
  }

  function dropInto(target: string | null, payloadRaw: string) {
    try {
      const items = JSON.parse(payloadRaw) as SelectionItem[];
      moveSet(
        items.filter((i) => !(i.kind === 'folder' && i.id === target)),
        target,
      );
    } catch {
      console.warn('[doc-explorer] Drag-Drop-Payload konnte nicht geparst werden');
    }
  }

  // Bulk-Freigabe/-Entzug: eine Action, Ablehnungen gesammelt anzeigen.
  function bulkShare(ids: string[], share: boolean) {
    if (ids.length === 0) return;
    start(async () => {
      ops.setOpError(null);
      const result = await actions.setShare({ documentIds: ids, share });
      const message = bulkResultMessage(
        result,
        ids.length,
        share ? 'freigegeben' : 'auf privat gesetzt',
      );
      if (message) ops.setOpError(message);
      onShared();
    });
  }

  function deleteFolder(id: string, name: string) {
    ops.setConfirmState({
      title: 'Ordner löschen',
      message: `Ordner „${name}" löschen?\nInhalt rückt eine Ebene hoch. Kein Dokument wird gelöscht.`,
      confirmLabel: 'Löschen',
      busyLabel: 'Löscht…',
      danger: true,
      // Die Action revalidiert; ihre Antwort rendert die Liste neu.
      action: () => actions.deleteFolder({ folderId: id }),
    });
  }

  // OS-Datei-Drop = Upload in den aktuellen Bereich/Ordner. Nur sinnvoll,
  // wenn ein Scope (Mandant/Kanzlei-intern) offen ist und nicht im
  // Gelöscht-Modus. Typ = Default-Typ der Kanzlei (GENERAL/erste NONE).
  function uploadDropped(files: File[]) {
    if (!scope || deleted || files.length === 0) return;
    void (async () => {
      let typeId = '';
      try {
        const r = await fetch('/api/staff/document-types');
        if (r.ok) {
          const d = (await r.json()) as {
            types: { id: string; classificationKey: string | null; tier: string }[];
          };
          typeId = defaultDropTypeId(d.types);
        }
      } catch {
        console.warn('[doc-explorer] Datei-Typ-Ermittlung fehlgeschlagen');
      }
      if (!typeId) {
        ops.setOpError('Kein Datei-Typ verfügbar.');
        return;
      }
      start(() => {
        void (async () => {
          ops.setOpError(null);
          const errs: string[] = [];
          for (const f of files) {
            const fd = dropUploadFormData(f, typeId, scope.clientId, currentFolderId);
            const res = await fetch('/api/staff/documents/commit', { method: 'POST', body: fd });
            if (!res.ok) {
              const b = await res.json().catch(() => ({}));
              errs.push(`${f.name}: ${(b as { error?: string }).error ?? res.status}`);
            }
          }
          if (errs.length) ops.setOpError(`Upload-Fehler:\n${errs.join('\n')}`);
          router.refresh();
        })().catch((err) => {
          console.warn('[doc-explorer] Drop-Upload fehlgeschlagen', err);
          ops.setOpError('Drop-Upload fehlgeschlagen.');
        });
      });
    })().catch((err) => {
      console.warn('[doc-explorer] Drop-Upload fehlgeschlagen', err);
      ops.setOpError('Drop-Upload fehlgeschlagen.');
    });
  }

  return { moveSet, dropInto, bulkShare, deleteFolder, uploadDropped };
}

/** Datei-Drop aus dem Betriebssystem auf die ganze Ansicht (Overlay + Upload). */
export function useOsFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [active, setActive] = useState(false);
  return {
    active,
    handlers: {
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (enabled && isOsFileDrag(e.dataTransfer)) {
          e.preventDefault();
          setActive(true);
        }
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if (e.currentTarget === e.target) setActive(false);
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        if (enabled && isOsFileDrag(e.dataTransfer)) {
          e.preventDefault();
          setActive(false);
          onFiles(Array.from(e.dataTransfer.files));
        }
      },
    },
  };
}
