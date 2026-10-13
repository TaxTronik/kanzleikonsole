// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@/server/dashboard/widgets';

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('../actions', () => ({
  addDashboardWidgetAction: vi.fn(),
  saveDashboardLayoutAction: h.save,
  resetDashboardLayoutAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn() }));
// Ohne Drag-Editor: Dessen Kompaktierungs-Rückmeldungen gehören nicht zu
// diesem Test; das verzögerte Laden prüft dashboard-lazy-editor.test.tsx.
vi.mock('../dashboard-grid-editor', () => ({ DashboardGridEditor: () => null }));

import { AccessibleDisplayProvider } from '@/components/accessible-display';
import { DashboardLayoutControls } from '../dashboard-layout-controls';
import { DashboardGrid } from '../dashboard-grid';
import {
  adjustDashboardWidget,
  compactDashboardWidgets,
  dashboardGeometryDescription,
} from '../dashboard-layout-adjustment';

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
});

function grid() {
  return (
    <DashboardGrid
      initialLayout={DEFAULT_LAYOUT}
      renderedWidgets={DEFAULT_LAYOUT.widgets.map((widget) => ({
        widget,
        node: <div className="card">Inhalt {widget.id}</div>,
      }))}
      enabledWidgetTypes={DEFAULT_LAYOUT.widgets.map((widget) => widget.type)}
    />
  );
}

async function openEditor() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
  });
}

function applyHeight(height: number) {
  const form = screen.getByRole('form', { name: 'Mandanten: Position und Größe' });
  fireEvent.change(within(form).getByLabelText('Höhe (Rasterzeilen)'), {
    target: { value: String(height) },
  });
  fireEvent.submit(form);
}

describe('Dashboard: Speicherweg der Alternative', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    h.save.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('speichert die angepasste Position über den bestehenden Layout-Speicherweg', async () => {
    render(grid());
    await openEditor();
    applyHeight(4);
    const expected = adjustDashboardWidget(compactDashboardWidgets(DEFAULT_LAYOUT.widgets), 'w-1', {
      x: 0,
      y: 0,
      w: 3,
      h: 4,
    });
    if (!expected.ok) throw new Error('Testannahme verletzt');
    const description = `Mandanten: ${dashboardGeometryDescription(expected.widget)}.`;
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(`${description} Änderungen werden gespeichert …`);
    expect(h.save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ version: 2, widgets: expected.widgets });
    expect(status.textContent).toBe(`${description} Layout gespeichert.`);
  });

  it('baut aufeinanderfolgende Anpassungen verschiedener Widgets auf dem aktuellen Stand auf', async () => {
    render(grid());
    await openEditor();
    applyHeight(4);
    fireEvent.change(screen.getByLabelText('Widget anpassen'), { target: { value: 'w-2' } });
    const form = screen.getByRole('form', { name: 'Offene Anforderungen: Position und Größe' });
    fireEvent.change(within(form).getByLabelText('Höhe (Rasterzeilen)'), {
      target: { value: '5' },
    });
    fireEvent.submit(form);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const first = adjustDashboardWidget(compactDashboardWidgets(DEFAULT_LAYOUT.widgets), 'w-1', {
      x: 0,
      y: 0,
      w: 3,
      h: 4,
    });
    if (!first.ok) throw new Error('Testannahme verletzt');
    const second = adjustDashboardWidget(first.widgets, 'w-2', { x: 3, y: 0, w: 3, h: 5 });
    if (!second.ok) throw new Error('Testannahme verletzt');
    // Debounce: nur der letzte Stand wird gespeichert, mit beiden Änderungen.
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ version: 2, widgets: second.widgets });
  });

  it('meldet Speicherfehler als Alarm und leert die Statusmeldung', async () => {
    h.save.mockResolvedValueOnce({ ok: false, error: 'Layout ist veraltet.' });
    render(grid());
    await openEditor();
    applyHeight(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByRole('alert').textContent).toBe('Layout ist veraltet.');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('führt den Fokus nach dem Entfernen auf den Bearbeiten-Schalter zurück', async () => {
    render(grid());
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Widget entfernen: Mandanten' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fertig' }));
    expect(screen.getByRole('status').textContent).toBe(
      'Widget entfernt. Änderungen werden gespeichert …',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.save.mock.calls[0]![0].widgets.map((widget: { id: string }) => widget.id)).toEqual([
      'w-2',
      'w-3',
      'w-4',
      'w-5',
      'w-6',
    ]);
  });

  it('bietet die Alternative unabhängig vom barrierearmen Anzeigemodus an', async () => {
    const markup = async (enabled: boolean) => {
      const view = render(
        <AccessibleDisplayProvider initialEnabled={enabled} saveAction={async () => ({ ok: true })}>
          {grid()}
        </AccessibleDisplayProvider>,
      );
      await openEditor();
      const section = screen.getByRole('region', { name: 'Position und Größe ohne Ziehen' });
      const html = section.outerHTML.replace(/_r_[0-9a-z]+_/g, 'ID');
      view.unmount();
      return html;
    };
    expect(await markup(true)).toBe(await markup(false));
  });
});
