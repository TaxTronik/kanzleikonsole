'use client';

/**
 * Sortierbare Vorlagenfelder und Arbeitsschritte mit Zeigergriff und
 * Schaltflächen für das schrittweise Verschieben.
 */

import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';

interface Props {
  count: number;
  onReorder: (from: number, to: number) => void;
  renderItem: (index: number, dragHandleProps: DragHandleProps) => ReactNode;
  /** Tailwind-Klassen für den Container. */
  className?: string;
}

export interface DragHandleProps {
  onReorder: Props['onReorder'];
  index: number;
  count: number;
}

export function SortableList({ count, onReorder, renderItem, className }: Props) {
  const drag = useRef<{ pointerId: number; from: number; to: number } | null>(null);
  const [draggingFrom, setDraggingFrom] = useState<number | null>(null);
  const [hoverTarget, setHoverTarget] = useState<number | null>(null);

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current || e.button !== 0) return;
    const grip = (e.target as Element).closest<HTMLElement>('[data-sortable-grip]');
    if (!grip || grip.closest('[data-sortable-list]') !== e.currentTarget) return;
    const index = Number(grip.dataset.sortableGrip);
    grip.setPointerCapture(e.pointerId);
    drag.current = { from: index, to: index, pointerId: e.pointerId };
    setDraggingFrom(index);
    setHoverTarget(index);
  }

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    const items = Array.from(e.currentTarget.children);
    const index = items.findIndex((item) => e.clientY <= item.getBoundingClientRect().bottom);
    active.to = index < 0 ? items.length - 1 : index;
    setHoverTarget(active.to);
  }

  function endDrag(e: ReactPointerEvent, commit: boolean) {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    drag.current = null;
    setDraggingFrom(null);
    setHoverTarget(null);
    if (commit && active.from !== active.to && active.from < count && active.to < count) {
      onReorder(active.from, active.to);
    }
  }

  return (
    <div
      data-sortable-list
      className={className ?? 'space-y-3'}
      onPointerDown={startDrag}
      onPointerMove={onMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onLostPointerCapture={(e) => endDrag(e, false)}
    >
      {Array.from({ length: count }, (_, i) => i).map((i) => {
        const isDragging = draggingFrom === i;
        const isDropTarget = draggingFrom !== null && hoverTarget === i && draggingFrom !== i;
        const handle: DragHandleProps = {
          onReorder,
          index: i,
          count,
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
 * Ziehgriff und schrittweise Bedienung per Tastatur oder Klick.
 */
export function DragHandle({ handle }: { handle: DragHandleProps }) {
  function move(button: HTMLButtonElement, step: -1 | 1) {
    const target = handle.index + step;
    handle.onReorder(handle.index, target);
    const nextStep = target + step < 0 || target + step >= handle.count ? -step : step;
    button
      .closest('[data-sortable-list]')
      ?.children[target]?.querySelector<HTMLElement>(`[data-sort-step="${nextStep}"]`)
      ?.focus();
  }
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        className="p-1 disabled:opacity-30"
        data-sort-step={-1}
        aria-label={`Element ${handle.index + 1} nach oben verschieben`}
        disabled={handle.index === 0}
        onClick={(event) => move(event.currentTarget, -1)}
      >
        <ChevronUp aria-hidden="true" className="h-4 w-4" />
      </button>
      <span
        aria-hidden="true"
        title="Ziehen zum Verschieben"
        data-sortable-grip={handle.index}
        className="text-muted cursor-grab active:cursor-grabbing touch-none p-1"
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <button
        type="button"
        className="p-1 disabled:opacity-30"
        data-sort-step={1}
        aria-label={`Element ${handle.index + 1} nach unten verschieben`}
        disabled={handle.index === handle.count - 1}
        onClick={(event) => move(event.currentTarget, 1)}
      >
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
