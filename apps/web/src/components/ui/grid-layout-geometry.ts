import { moveElement, verticalCompactor, type LayoutItem } from 'react-grid-layout/core';

export const GRID_COLUMNS = 12;
export const GRID_MAX_Y = 200;
export const GRID_MAX_HEIGHT = 40;

export interface GridGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type GridAdjustmentResult<T> =
  | { ok: true; items: T[]; item: T }
  | { ok: false; error: string };

/**
 * Same collision handling and vertical compaction as pointer editing in RGL.
 * Work on cloned entries: typing/validation must never change the saved layout.
 */
export function adjustGridItem<T extends GridGeometry & { id: string }>(
  widgets: readonly T[],
  id: string,
  geometry: GridGeometry,
  sizeLimits: (item: T) => { minW: number; minH: number },
  itemKind = 'Widget',
): GridAdjustmentResult<T> {
  const original = widgets.find((widget) => widget.id === id);
  if (!original)
    return {
      ok: false,
      error: `Dieses ${itemKind === 'Block' ? 'Element' : itemKind} ist nicht mehr vorhanden.`,
    };
  const limits = sizeLimits(original);
  const { x, y, w, h } = geometry;
  if (![x, y, w, h].every(Number.isInteger)) {
    return { ok: false, error: 'Bitte in allen vier Feldern ganze Zahlen eingeben.' };
  }
  if (w < limits.minW || w > GRID_COLUMNS || h < limits.minH || h > GRID_MAX_HEIGHT) {
    return {
      ok: false,
      error: `Die Breite muss zwischen ${limits.minW} und ${GRID_COLUMNS}, die Höhe zwischen ${limits.minH} und ${GRID_MAX_HEIGHT} liegen.`,
    };
  }
  if (x < 0 || x + w > GRID_COLUMNS || y < 0 || y > GRID_MAX_Y) {
    return {
      ok: false,
      error: `Die Startspalte muss zwischen 1 und ${GRID_COLUMNS - w + 1}, die Startzeile zwischen 1 und ${GRID_MAX_Y + 1} liegen.`,
    };
  }

  const layout: LayoutItem[] = widgets.map((widget) => ({
    i: widget.id,
    x: widget.x,
    y: widget.y,
    w: widget.id === id ? w : widget.w,
    h: widget.id === id ? h : widget.h,
  }));
  const target = layout.find((widget) => widget.i === id)!;
  const moved = moveElement(layout, target, x, y, true, false, 'vertical', GRID_COLUMNS);
  const compacted = verticalCompactor.compact(moved, GRID_COLUMNS);
  // Cascading collisions may push OTHER widgets below the server's bounds.
  // Reject the whole change, not a partially truncated or overlapping layout.
  if (compacted.some((widget) => widget.y > GRID_MAX_Y)) {
    return {
      ok: false,
      error:
        'Dafür reicht der verfügbare Layoutbereich nicht aus. Bitte eine andere Position oder Größe wählen.',
    };
  }
  const byId = new Map(compacted.map((widget) => [widget.i, widget]));
  const adjusted = widgets.map((widget) => {
    const position = byId.get(widget.id)!;
    return { ...widget, x: position.x, y: position.y, w: position.w, h: position.h };
  });
  return { ok: true, items: adjusted, item: adjusted.find((widget) => widget.id === id)! };
}

export function gridGeometryDescription(widget: GridGeometry): string {
  return `Spalte ${widget.x + 1}, Zeile ${widget.y + 1}, Breite ${widget.w}, Höhe ${widget.h}`;
}
