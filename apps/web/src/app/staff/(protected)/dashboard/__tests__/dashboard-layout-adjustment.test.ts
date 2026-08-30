import { describe, expect, it } from 'vitest';
import { collides, verticalCompactor } from 'react-grid-layout/core';
import { DEFAULT_LAYOUT, type LayoutWidget } from '@/server/dashboard/widgets';
import {
  adjustDashboardWidget,
  dashboardGeometryDescription,
} from '../dashboard-layout-adjustment';

function widget(overrides: Partial<LayoutWidget> = {}): LayoutWidget {
  return { id: 'first', type: 'kpi_clients', x: 0, y: 0, w: 3, h: 3, ...overrides };
}

describe('Dashboard: Position und Größe ohne Ziehen', () => {
  it('wendet Position und Größe an, ohne Eingabelayout oder Reihenfolge zu verändern', () => {
    const first = Object.freeze(widget());
    const second = Object.freeze(widget({ id: 'second', type: 'kpi_documents', x: 8 }));
    const original = Object.freeze([first, second]);
    const result = adjustDashboardWidget(original, first.id, { x: 3, y: 0, w: 4, h: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.widget).toEqual({ ...first, x: 3, w: 4, h: 5 });
    expect(result.widgets.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(original).toEqual([widget(), widget({ id: 'second', type: 'kpi_documents', x: 8 })]);
    expect(result.widgets[1]).not.toBe(second);
  });

  it('verdrängt andere Widgets und liefert das tatsächlich verdichtete Raster zurück', () => {
    const result = adjustDashboardWidget(DEFAULT_LAYOUT.widgets, 'w-1', {
      x: 3,
      y: 0,
      w: 6,
      h: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const layout = result.widgets.map((entry) => ({ ...entry, i: entry.id }));
    for (let index = 0; index < layout.length; index += 1) {
      for (const other of layout.slice(index + 1)) {
        expect(collides(layout[index]!, other)).toBe(false);
      }
    }
    expect(verticalCompactor.compact(layout, 12).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(
      layout.map(({ x, y, w, h }) => ({ x, y, w, h })),
    );
  });

  it('beschreibt die tatsächlich angewendete statt der angeforderten Leerzeile', () => {
    const result = adjustDashboardWidget([widget()], 'first', { x: 0, y: 100, w: 3, h: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.widget.y).toBe(0);
    expect(dashboardGeometryDescription(result.widget)).toBe('Spalte 1, Zeile 1, Breite 3, Höhe 3');
  });

  it.each([
    { x: -1, y: 0, w: 3, h: 3 },
    { x: 10, y: 0, w: 3, h: 3 },
    { x: 0, y: -1, w: 3, h: 3 },
    { x: 0, y: 201, w: 3, h: 3 },
    { x: 0, y: 0, w: 1, h: 3 },
    { x: 0, y: 0, w: 13, h: 3 },
    { x: 0, y: 0, w: 3, h: 2 },
    { x: 0, y: 0, w: 3, h: 41 },
    { x: 0, y: 0, w: 3.5, h: 3 },
    { x: Number.NaN, y: 0, w: 3, h: 3 },
    { x: 0, y: Number.POSITIVE_INFINITY, w: 3, h: 3 },
  ])('verwirft ungültige Grenzen atomar: %j', (geometry) => {
    const original = [widget()];
    expect(adjustDashboardWidget(original, 'first', geometry).ok).toBe(false);
    expect(original).toEqual([widget()]);
  });

  it('beachtet die individuellen Mindestgrößen', () => {
    const original = [widget({ type: 'calendar', w: 6, h: 12 })];
    expect(adjustDashboardWidget(original, 'first', { x: 0, y: 0, w: 3, h: 6 }).ok).toBe(false);
    expect(adjustDashboardWidget(original, 'first', { x: 0, y: 0, w: 4, h: 5 }).ok).toBe(false);
    expect(adjustDashboardWidget(original, 'first', { x: 8, y: 0, w: 4, h: 6 }).ok).toBe(true);
  });

  it('weist einen Überlauf anderer Widgets nach einer Kollision zurück', () => {
    const original = Array.from({ length: 8 }, (_, index) =>
      widget({ id: String(index), x: 0, y: index * 25, w: 12, h: 25 }),
    );
    const result = adjustDashboardWidget(original, '0', { x: 0, y: 0, w: 12, h: 40 });
    // Last row becomes 190 and is allowed, but a second tall resize would
    // push another widget's start past the server's maximum of 200.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const overflow = adjustDashboardWidget(result.widgets, '1', { x: 0, y: 40, w: 12, h: 40 });
    expect(overflow.ok).toBe(false);
    expect(result.widgets.find(({ id }) => id === '1')?.h).toBe(25);
  });

  it('meldet ein zwischenzeitlich entferntes Widget', () => {
    expect(adjustDashboardWidget([], 'missing', { x: 0, y: 0, w: 3, h: 3 })).toEqual({
      ok: false,
      error: 'Dieses Widget ist nicht mehr vorhanden.',
    });
  });
});
