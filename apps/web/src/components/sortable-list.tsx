'use client';

/**
 * Schlanke Sortable-Liste mit Pointer-Events (funktioniert mit Maus + Touch).
 * Bewusst KEIN react-dnd / dnd-kit — die wären 30 kB Bundle für einen Effekt,
 * der nativ in ~80 Zeilen geht.
 *
 * Strategie:
 *   - Drag-Handle ruft `onPointerDown(index)` auf
 *   - Beim Pointer-Move wird das Element unter dem Cursor ermittelt
 *   - Beim Release: `onReorder(from, to)`
 *
 * Visuell: das gedraggte Item wird halb-transparent, der Drop-Target-Bereich
 * bekommt einen blauen Top-Border-Indikator.
 */

import { useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical } from 'lucide-react';

interface Props {
  count: number;
  onReorder: (from: number, to: number) => void;
  renderItem: (index: number, dragHandleProps: DragHandleProps) => ReactNode;
  /** Tailwind-Klassen für den Container. */
  className?: string;
}

export interface DragHandleProps {
  onPointerDown: (e: ReactPointerEvent) => void;
  className: string;
  title: string;
  role: string;
  'aria-label': string;
}

export function SortableList({ count, onReorder, renderItem, className }: Props) {
  const [draggingFrom, setDraggingFrom] = useState<number | null>(null);
  const [hoverTarget, setHoverTarget] = useState<number | null>(null);

  function startDrag(index: number, e: ReactPointerEvent) {
    const container = e.currentTarget.closest('[data-sortable-list]');
    if (!container) return;
    let currentTarget = index;
    setDraggingFrom(index);
    setHoverTarget(index);
    (e.target as Element).setPointerCapture?.(e.pointerId);

    function onMove(ev: globalThis.PointerEvent) {
      const items = Array.from(container!.querySelectorAll<HTMLElement>('[data-sortable-index]'));
      let target = index;
      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          target = Number(el.dataset['sortableIndex']);
          break;
        }
      }
      // Außerhalb? Top/Bottom clampen
      const first = items[0];
      const last = items[items.length - 1];
      if (first && ev.clientY < first.getBoundingClientRect().top) target = 0;
      if (last && ev.clientY > last.getBoundingClientRect().bottom) target = items.length - 1;
      currentTarget = target;
      setHoverTarget(target);
    }

    function onUp(ev: globalThis.PointerEvent) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setDraggingFrom(null);
      setHoverTarget(null);
      // Seiteneffekt AUSSERHALB jeder setState-Updater-Funktion.
      if (index !== currentTarget) {
        onReorder(index, currentTarget);
      }
      void ev;
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  return (
    <div data-sortable-list className={className ?? 'space-y-3'}>
      {Array.from({ length: count }, (_, i) => i).map((i) => {
        const isDragging = draggingFrom === i;
        const isDropTarget = draggingFrom !== null && hoverTarget === i && draggingFrom !== i;
        const handle: DragHandleProps = {
          onPointerDown: (e) => startDrag(i, e),
          className:
            'text-disabled hover:text-secondary cursor-grab active:cursor-grabbing touch-none p-1',
          title: 'Ziehen zum Verschieben',
          role: 'button',
          'aria-label': 'Element verschieben',
        };
        return (
          <div
            key={i}
            data-sortable-index={i}
            className={
              'transition-shadow ' +
              (isDragging ? 'opacity-50 ' : '') +
              (isDropTarget ? 'ring-2 ring-focus rounded-lg ' : '')
            }
          >
            {renderItem(i, handle)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Vorgefertigtes Drag-Icon zum Einsatz in `renderItem`. Nimmt
 * dragHandleProps + zusätzliche Visibility-Klasse.
 */
export function DragHandle({ handle }: { handle: DragHandleProps }) {
  return (
    <span {...handle}>
      <GripVertical className="h-4 w-4" />
    </span>
  );
}
