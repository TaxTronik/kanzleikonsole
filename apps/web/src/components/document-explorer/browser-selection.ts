'use client';
// =============================================================================
// Auswahl der Browser-Variante (Review-Befund K-04): Dateien und Ordner der
// aktuellen Ebene, Mehrfachauswahl per Checkbox, Einzelauswahl per Zeilen-
// bzw. Kontextmenü und die Drag-Nutzlast (gezogenes Element oder die ganze
// Auswahl). Die Auswahl gehört zum geöffneten Bereich: index.tsx setzt sie per
// Schlüssel bei Ordner-, Such- oder Bereichswechsel zurück.
// =============================================================================

import { useMemo, useState } from 'react';
import type { Entry } from '@/components/document-browser-utils';

export type SelectableKind = 'file' | 'folder';
export interface SelectionItem {
  kind: SelectableKind;
  id: string;
}
export type FileEntry = Extract<Entry, { kind: 'file' }>;

export function selectionKey(item: SelectionItem): string {
  return `${item.kind}:${item.id}`;
}

/** Fügt das Element hinzu oder entfernt es (Checkbox). */
export function toggleSelection(
  previous: SelectionItem[],
  kind: SelectableKind,
  id: string,
): SelectionItem[] {
  const has = previous.some((item) => item.kind === kind && item.id === id);
  return has
    ? previous.filter((item) => !(item.kind === kind && item.id === id))
    : [...previous, { kind, id }];
}

export function idsOfKind(selection: SelectionItem[], kind: SelectableKind): string[] {
  return selection.filter((item) => item.kind === kind).map((item) => item.id);
}

/** Drag-Nutzlast: gezogenes Element, oder die ganze Auswahl, wenn es dazugehört. */
export function dragPayload(
  selection: SelectionItem[],
  selected: ReadonlySet<string>,
  entry: Entry,
): SelectionItem[] {
  if (entry.kind === 'nav') return [];
  const me: SelectionItem = { kind: entry.kind, id: entry.id };
  return selected.has(selectionKey(me)) && selection.length > 0 ? selection : [me];
}

/** Ausgewählte Dateien in Listenreihenfolge (für den Lösch-Dialog). */
export function selectedFileEntries(entries: Entry[], selected: ReadonlySet<string>): FileEntry[] {
  return entries.filter(
    (entry): entry is FileEntry =>
      entry.kind === 'file' && selected.has(selectionKey({ kind: 'file', id: entry.id })),
  );
}

export function useBrowserSelection(entries: Entry[]) {
  const [selection, setSelection] = useState<SelectionItem[]>([]);
  const selected = useMemo(() => new Set(selection.map(selectionKey)), [selection]);
  return {
    selection,
    isSelected: (kind: SelectableKind, id: string) => selected.has(selectionKey({ kind, id })),
    toggle: (kind: SelectableKind, id: string) =>
      setSelection((previous) => toggleSelection(previous, kind, id)),
    selectOnly: (kind: SelectableKind, id: string) => setSelection([{ kind, id }]),
    clear: () => setSelection([]),
    fileIds: () => idsOfKind(selection, 'file'),
    folderIds: () => idsOfKind(selection, 'folder'),
    /** Nur Dateien ausgewählt (dann gibt es Typ ändern, Freigeben, Löschen). */
    onlyFiles: selection.every((item) => item.kind === 'file'),
    selectedFiles: () => selectedFileEntries(entries, selected),
    dragPayload: (entry: Entry) => dragPayload(selection, selected, entry),
  };
}
export type BrowserSelection = ReturnType<typeof useBrowserSelection>;
