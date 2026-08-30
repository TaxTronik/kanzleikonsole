import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@/server/dashboard/widgets';
import { DashboardLayoutControls } from '../dashboard-layout-controls';

describe('Dashboard: benannte Layout-Bedienelemente', () => {
  it('stellt außerhalb kleiner Widgets ein Formular mit Namen und Grenzen bereit', () => {
    const onApply = vi.fn();
    const html = renderToStaticMarkup(
      <DashboardLayoutControls
        widgets={DEFAULT_LAYOUT.widgets}
        disabled={false}
        onApply={onApply}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toContain('Position und Größe ohne Ziehen');
    expect(html).toContain('aria-label="Mandanten: Position und Größe"');
    expect(html).toContain('Widget anpassen');
    for (const label of ['Startspalte', 'Startzeile', 'Breite (Spalten)', 'Höhe (Rasterzeilen)']) {
      expect(html).toContain(`<label class="label block" for=`);
      expect(html).toContain(label);
    }
    expect(html.match(/type="number"/g)).toHaveLength(4);
    expect(html.match(/step="1" required=""/g)).toHaveLength(4);
    expect(html).toContain('type="submit"');
    expect(html).toContain('Übernehmen');
    expect(html).toContain('type="reset"');
    expect(html).toContain('Widget entfernen: Mandanten');
    expect(html).toContain('grid-cols-1');
    expect(html).not.toContain('draggable="true"');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('sperrt Formular und Auswahl während eines Resets', () => {
    const html = renderToStaticMarkup(
      <DashboardLayoutControls
        widgets={DEFAULT_LAYOUT.widgets}
        disabled
        onApply={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toMatch(/<fieldset disabled=""/);
  });

  it('zeigt bei leerem Layout keine unbedienbaren Felder', () => {
    expect(
      renderToStaticMarkup(
        <DashboardLayoutControls
          widgets={[]}
          disabled={false}
          onApply={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    ).toBe('');
  });

  it('bindet die Alternative unabhängig vom Profilmodus an den bestehenden Speicherweg', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard-grid.tsx'),
      'utf8',
    );
    expect(source).toContain('onApply={applyGeometry}');
    expect(source).toContain('adjustDashboardWidget(widgetsRef.current, id, geometry)');
    expect(source).toContain('saveDashboardLayoutAction({ version: 2, widgets: snapshot })');
    expect(source).toContain('role="status"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('editButtonRef.current?.focus()');
    expect(source).not.toContain('useAccessibleDisplay');
  });
});
