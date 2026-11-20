'use client';

// =============================================================================
// FolderTreePicker — gemeinsamer, rekursiver Ordnerbaum mit Auswahl.
// Genutzt von document-dialogs (MoveDialog, MoveTargetDialog) und dem
// DocumentExplorer (Sidebar der Variante "embedded"). Zeilen sind
// tastaturbedienbar (Enter/Leertaste).
// =============================================================================

import { useMemo, useState, type ReactNode } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { foldersByParent, type FolderNode } from '@/components/document-browser-utils';

export function FolderTreePicker({
  folders,
  value,
  onSelect,
  rootLabel,
  disabledIds,
  indent = 16,
  showCheck = false,
  emptyLabel = 'Keine Ordner in diesem Bereich.',
  rowExtra,
}: {
  folders: FolderNode[];
  /** Ausgewählte Ordner-ID; null = Wurzel (falls rootLabel) bzw. keine Auswahl. */
  value: string | null;
  onSelect: (id: string | null) => void;
  /** Optionale Wurzel-Zeile (wählt null), z. B. „— Ohne Ordner (Wurzel) —". */
  rootLabel?: string;
  /** Gesperrte Ziele (z. B. eigener Teilbaum beim Verschieben). */
  disabledIds?: Set<string>;
  /** Einrückung pro Ebene in px. */
  indent?: number;
  /** Häkchen am ausgewählten Eintrag (Picker-Dialoge). */
  showCheck?: boolean;
  emptyLabel?: string;
  /** Zusatzinhalt pro Zeile (z. B. Zähler, Hover-Aktionen). */
  rowExtra?: (f: FolderNode) => ReactNode;
}) {
  const { childrenOf, parents } = useMemo(() => {
    const children = foldersByParent(folders);
    for (const siblings of children.values())
      siblings.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return { childrenOf: children, parents: new Map(folders.map((f) => [f.id, f.parentId])) };
  }, [folders]);
  const ancestors = useMemo(() => {
    const path = new Set<string>();
    let parent = value === null ? null : parents.get(value);
    while (parent != null && !path.has(parent)) {
      path.add(parent);
      parent = parents.get(parent);
    }
    return path;
  }, [value, parents]);
  const [tree, setTree] = useState(() => ({ value, expanded: new Map<string, boolean>() }));
  if (tree.value !== value) {
    const expanded = new Map(tree.expanded);
    for (const id of ancestors) expanded.delete(id);
    setTree({ value, expanded });
  }

  function row(f: FolderNode, depth: number) {
    const kids = childrenOf.get(f.id) ?? [];
    const open = tree.expanded.get(f.id) ?? ancestors.has(f.id);
    const isSel = value === f.id;
    const dis = disabledIds?.has(f.id) ?? false;
    return (
      <div key={f.id}>
        {/* Die Zeile ist kein Button: Auswahl, Auf-/Zuklappen und die Aktionen
            aus rowExtra sind Geschwister. Verschachtelte Bedienelemente
            (role="button" um weitere Buttons) kann ein Screenreader nicht
            einzeln ansteuern (axe: nested-interactive). Der Auswahl-Button
            füllt die Zeile bis auf Zähler und Aktionen. */}
        <div
          className={`flex items-center gap-1 rounded px-2 py-1.5 text-sm group ${
            dis
              ? 'opacity-40'
              : isSel
                ? 'bg-brand-50 text-brand-700'
                : 'hover:bg-gray-50 text-secondary'
          }`}
          style={{ paddingLeft: `${depth * indent + 8}px` }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${f.name} ${open ? 'zuklappen' : 'aufklappen'}`}
              onClick={() => setTree({ value, expanded: new Map(tree.expanded).set(f.id, !open) })}
              className="text-disabled"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span aria-hidden="true" className="w-3.5 shrink-0" />
          )}
          <button
            type="button"
            disabled={dis}
            aria-pressed={isSel}
            onClick={() => onSelect(f.id)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left disabled:cursor-not-allowed"
          >
            {isSel ? (
              <FolderOpen className="h-4 w-4 shrink-0" />
            ) : (
              <Folder className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate flex-1">{f.name}</span>
          </button>
          {rowExtra?.(f)}
          {showCheck && isSel && <Check className="h-3.5 w-3.5" />}
        </div>
        {open && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  }

  return (
    <div>
      {rootLabel !== undefined && (
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => onSelect(null)}
          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm cursor-pointer ${
            value === null ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
        >
          <Folder className="h-4 w-4 text-disabled" />
          <span className="flex-1">{rootLabel}</span>
          {showCheck && value === null && <Check className="h-3.5 w-3.5" />}
        </button>
      )}
      {(childrenOf.get(null) ?? []).map((f) => row(f, 0))}
      {folders.length === 0 && <p className="px-2 py-3 text-xs text-disabled">{emptyLabel}</p>}
    </div>
  );
}
