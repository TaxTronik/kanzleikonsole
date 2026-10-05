import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type AtRule, type Rule } from 'postcss';
import { renderToStaticMarkup } from 'react-dom/server';
import { correctBounds, verticalCompactor } from 'react-grid-layout/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAYOUT,
  type DashboardLayout,
  type LayoutWidget,
} from '@/server/dashboard/widgets';

vi.mock('../actions', () => ({
  addDashboardWidgetAction: vi.fn(),
  saveDashboardLayoutAction: vi.fn(),
  resetDashboardLayoutAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn() }));

import { DashboardGrid } from '../dashboard-grid';
import { compactDashboardWidgets } from '../dashboard-layout-adjustment';

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, path), 'utf8');
const appDir = resolve(here, '../../../..');

function widget(id: string, x: number, y: number, w: number, h: number): LayoutWidget {
  return { id, type: 'kpi_clients', x, y, w, h };
}

function render(layout: DashboardLayout): string {
  return renderToStaticMarkup(
    <DashboardGrid
      initialLayout={layout}
      renderedWidgets={layout.widgets.map((entry) => ({
        widget: entry,
        node: <div className="card">Inhalt {entry.id}</div>,
      }))}
      enabledWidgetTypes={layout.widgets.map((entry) => entry.type)}
    />,
  );
}

describe('Dashboard-Leseansicht als serverseitiges CSS-Grid (P-24)', () => {
  it('rendert alle Widgets sofort sichtbar ins HTML, ohne react-grid-layout', () => {
    const html = render(DEFAULT_LAYOUT);
    for (const entry of DEFAULT_LAYOUT.widgets) expect(html).toContain(`Inhalt ${entry.id}`);
    expect(html).toContain('class="dashboard-view"');
    expect(html).toContain('class="dashboard-view-grid"');
    expect(html.match(/class="dashboard-view-item"/g)).toHaveLength(DEFAULT_LAYOUT.widgets.length);
    expect(html).not.toContain('visibility');
    expect(html).not.toContain('react-grid');
    expect(html).toContain('--dg-col:1 / span 3;--dg-row:1 / span 3;--dg-h:3');
  });

  it('zeigt gespeicherte Layouts an denselben Positionen wie der Editor (RGL-Kompaktierung)', () => {
    const gaps = [
      widget('a', 0, 4, 3, 3),
      widget('b', 3, 10, 6, 8),
      widget('c', 9, 0, 3, 9),
      widget('d', 0, 20, 3, 3),
    ];
    expect(compactDashboardWidgets(gaps).map(({ id, x, y }) => [id, x, y])).toEqual([
      ['a', 0, 0],
      ['b', 3, 0],
      ['c', 9, 0],
      ['d', 0, 3],
    ]);
    const overflow = [widget('a', 10, 0, 4, 3), widget('b', 0, 3, 12, 6), widget('c', 8, 0, 2, 3)];
    const compacted = compactDashboardWidgets(overflow);
    expect(compacted.map(({ id, x, y, w }) => [id, x, y, w])).toEqual([
      ['a', 8, 0, 4],
      ['b', 0, 6, 12],
      ['c', 8, 3, 2],
    ]);
    // Dieselben Kernfunktionen, die GridLayout beim Mount anwendet.
    const rgl = verticalCompactor.compact(
      correctBounds(
        overflow.map(({ id, x, y, w, h }) => ({ i: id, x, y, w, h })),
        { cols: 12 },
      ),
      12,
    );
    expect(compacted.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(
      rgl.map(({ x, y, w, h }) => ({ x, y, w, h })),
    );
    expect(compactDashboardWidgets(compacted)).toEqual(compacted);
    // Gleiches Datenformat: nur Positionen ändern sich, Eingabe bleibt unberührt.
    expect(compacted.map((entry) => Object.keys(entry).sort())).toEqual(
      overflow.map((entry) => Object.keys(entry).sort()),
    );
    expect(overflow[0]).toEqual(widget('a', 10, 0, 4, 3));
  });

  it('ordnet die Items nach Zeile und Spalte (Tab- und Lesereihenfolge im Stapel)', () => {
    const layout: DashboardLayout = {
      version: 2,
      widgets: [widget('z', 6, 6, 6, 10), widget('y', 0, 0, 3, 3), widget('x', 0, 3, 6, 8)],
    };
    const html = render(layout);
    const order = [...html.matchAll(/Inhalt (\w)/g)].map((match) => match[1]);
    expect(order).toEqual(['y', 'z', 'x']);
  });

  it('stapelt unter 640px Containerbreite einspaltig und behält die gespeicherte Höhe', () => {
    const root = parse(source('../../../../globals.css'));
    const container = root.nodes.find(
      (node): node is AtRule =>
        node.type === 'atrule' && node.name === 'container' && node.params.includes('639.98px'),
    );
    expect(container).toBeDefined();
    const decls = (selector: string) => {
      const rule = container!.nodes!.find(
        (node): node is Rule => node.type === 'rule' && node.selector === selector,
      );
      return Object.fromEntries(rule!.nodes.map((node) => [String(node), node]));
    };
    expect(Object.keys(decls('.dashboard-view-grid'))).toEqual([
      'grid-template-columns: minmax(0, 1fr)',
    ]);
    expect(Object.keys(decls('.dashboard-view-item'))).toEqual([
      'grid-column: 1 / -1',
      'grid-row: auto / span var(--dg-h)',
    ]);
    expect(source('../../../../globals.css')).toContain('container-type: inline-size');
  });

  it('lädt react-grid-layout samt CSS nur im Bearbeitungsmodus', () => {
    const grid = source('../dashboard-grid.tsx');
    expect(grid).not.toMatch(/^import (?!type )[^;]*from 'react-grid-layout'/m);
    expect(grid).toContain("import type { Layout } from 'react-grid-layout';");
    expect(grid).toMatch(/dynamic\(\s*\(\) => import\('\.\/dashboard-grid-editor'\)/);
    expect(grid).toContain('ssr: false');
    const editor = source('../dashboard-grid-editor.tsx');
    expect(editor).toContain("from 'react-grid-layout';");
    expect(editor).toContain("import '@/components/ui/grid-layout-edit.css';");
    const globals = source('../../../../globals.css');
    expect(globals).not.toContain('react-grid-layout/css');
    expect(globals).not.toContain('react-resizable/css');
    const editCss = readFileSync(resolve(appDir, '../components/ui/grid-layout-edit.css'), 'utf8');
    expect(editCss).toContain("@import 'react-grid-layout/css/styles.css';");
    expect(editCss).toContain("@import 'react-resizable/css/styles.css';");
    expect(source('../../admin/settings/client-layout-form.tsx')).toContain(
      "import '@/components/ui/grid-layout-edit.css';",
    );
  });
});
