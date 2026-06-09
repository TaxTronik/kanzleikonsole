'use client';

// =============================================================================
// FolderTreePicker — gemeinsamer, rekursiver Ordnerbaum mit Auswahl.
// Genutzt von document-dialogs (MoveDialog, MoveTargetDialog) und dem
// DocumentExplorer (Sidebar der Variante "embedded"). Zeilen sind
// tastaturbedienbar (Enter/Leertaste).
// =============================================================================

import { useMemo, useState } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, Check } from 'lucide-react';
import type { FolderNode } from '@/components/document-browser-utils';

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
  rowExtra?: (f: FolderNode) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderNode[]>();
    for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    }
    return m;
  }, [folders]);

  const keySelect = (e: React.KeyboardEvent, id: string | null) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  };

  function row(f: FolderNode, depth: number) {
    const kids = childrenOf.get(f.id) ?? [];
    const open = expanded[f.id];
    const isSel = value === f.id;
    const dis = disabledIds?.has(f.id) ?? false;
    return (
      <div key={f.id}>
        <div
          role="button"
          tabIndex={dis ? -1 : 0}
          aria-disabled={dis || undefined}
          aria-pressed={isSel}
          onClick={() => !dis && onSelect(f.id)}
          onKeyDown={(e) => !dis && keySelect(e, f.id)}
          className={`flex items-center gap-1 rounded px-2 py-1.5 text-sm group ${
            dis
              ? 'opacity-40 cursor-not-allowed'
              : isSel
                ? 'bg-brand-50 text-brand-700 cursor-pointer'
                : 'hover:bg-gray-50 text-secondary cursor-pointer'
          }`}
          style={{ paddingLeft: `${depth * indent + 8}px` }}
        >
          <button
            type="button"
            aria-label={open ? 'Zuklappen' : 'Aufklappen'}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => ({ ...x, [f.id]: !x[f.id] }));
            }}
            tabIndex={kids.length ? 0 : -1}
            className={kids.length ? 'text-disabled' : 'invisible'}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {isSel ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
          <span className="truncate flex-1">{f.name}</span>
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
        <div
          role="button"
          tabIndex={0}
          aria-pressed={value === null}
          onClick={() => onSelect(null)}
          onKeyDown={(e) => keySelect(e, null)}
          className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer ${
            value === null ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
        >
          <Folder className="h-4 w-4 text-disabled" />
          <span className="flex-1">{rootLabel}</span>
          {showCheck && value === null && <Check className="h-3.5 w-3.5" />}
        </div>
      )}
      {(childrenOf.get(null) ?? []).map((f) => row(f, 0))}
      {folders.length === 0 && (
        <p className="px-2 py-3 text-xs text-disabled">{emptyLabel}</p>
      )}
    </div>
  );
}
