// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Layout } from 'react-grid-layout';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@/server/dashboard/widgets';
import { DEFAULT_CLIENT_LAYOUT } from '@/server/settings/client-layout-shared';
import { ClientLayoutForm } from '../../admin/settings/client-layout-form';
import { DashboardGrid } from '../dashboard-grid';
import { DashboardGridEditor } from '../dashboard-grid-editor';

type GridEvents = {
  layout: Layout;
  onLayoutChange?: (layout: Layout) => void;
  onDrag?: () => void;
  onDragStop?: (layout: Layout) => void;
  onResizeStop?: (layout: Layout) => void;
  children: ReactNode;
};
const h = vi.hoisted(() => ({ grid: null as GridEvents | null, save: vi.fn() }));
vi.mock('react-grid-layout', () => ({
  useContainerWidth: () => ({ mounted: true, width: 1100, containerRef: { current: null } }),
  GridLayout: (props: GridEvents) => {
    h.grid = props;
    return props.children;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../actions', () => ({
  saveDashboardLayoutAction: h.save,
  addDashboardWidgetAction: vi.fn(),
  resetDashboardLayoutAction: vi.fn(),
}));
vi.mock('../../admin/settings/actions', () => ({
  saveClientLayoutAction: h.save,
  resetClientLayoutAction: vi.fn(),
}));

beforeEach(() => {
  h.grid = null;
  h.save.mockReset().mockResolvedValue({ ok: true });
});

it.each(['Dashboard', 'ACP'])(
  '%s übernimmt Tastatur und abgeschlossene Zeigergesten ohne veraltete Rasterstände',
  async (editor) => {
    if (editor === 'Dashboard') {
      const widgets = DEFAULT_LAYOUT.widgets.slice(0, 2);
      render(
        <DashboardGrid
          initialLayout={{ version: 2, widgets }}
          renderedWidgets={widgets.map((widget) => ({ widget, node: widget.id }))}
          enabledWidgetTypes={widgets.map((widget) => widget.type)}
        />,
      );
    } else {
      render(<ClientLayoutForm initial={{ items: DEFAULT_CLIENT_LAYOUT.items.slice(1, 3) }} />);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await waitFor(() => expect(h.grid).toBeTruthy());
    const original = h.grid!.layout;
    const controls = within(screen.getByRole('region', { name: 'Position und Größe ohne Ziehen' }));
    const apply = controls.getByRole('button', { name: 'Übernehmen' });
    fireEvent.change(controls.getByLabelText('Startspalte'), { target: { value: '1' } });
    fireEvent.change(controls.getByLabelText('Breite (Spalten)'), { target: { value: '12' } });
    fireEvent.click(apply);
    // RGL meldet beim Mount und beim Abgleich seiner Props auch alte Layouts.
    act(() => h.grid!.onLayoutChange?.(original));
    expect(controls.getByText(/^Aktuell:/).textContent).toContain('Breite 12');
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce(), { timeout: 3000 });
    const payload = (call: number): Array<{ id: string; w: number; y: number }> =>
      h.save.mock.calls[call]![0][editor === 'Dashboard' ? 'widgets' : 'items'];
    expect(payload(0)[0]!.w).toBe(12);

    const [first, second] = h.grid!.layout;
    // Der verschobene Nachbar und das gezogene Widget kommen als vollständiger,
    // bereits kompaktierter RGL-Endstand; die Reihenfolge im Payload bleibt stabil.
    const moved = [
      { ...second!, y: 0 },
      { ...first!, y: second!.h },
    ];
    act(() => h.grid!.onDragStop!(moved));
    expect(controls.getByText(/^Aktuell:/).textContent).toContain(`Zeile ${second!.h + 1}`);
    const resized = [
      { ...first!, y: second!.h, w: 6 },
      // Ein Warteschlangenstand kann bereits entfernte IDs enthalten und
      // aktuell nicht gerenderte IDs auslassen.
      { ...second!, i: 'entfernt', y: 0 },
    ];
    act(() => h.grid!.onResizeStop!(resized));
    act(() => h.grid!.onLayoutChange?.(original));
    expect(controls.getByText(/^Aktuell:/).textContent).toContain('Breite 6');
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(payload(1).map(({ id, y, w }) => [id, y, w])).toEqual([
      [first!.i, second!.h, 6],
      [second!.i, 0, second!.w],
    ]);
  },
);

it('lässt einen verlinkten Widgetinhalt ziehen und öffnet ihn beim Loslassen nicht', () => {
  const widget = DEFAULT_LAYOUT.widgets[0]!;
  render(
    <DashboardGridEditor
      widgets={[widget]}
      renderById={new Map([[widget.id, <a href="#mandanten">Mandanten</a>]])}
      onPointerLayout={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  const link = screen.getByText('Mandanten', { selector: 'a' });
  fireEvent.pointerDown(link);
  expect(fireEvent.dragStart(link)).toBe(false);
  act(() => h.grid!.onDrag!());
  expect(fireEvent.click(link, { detail: 1 })).toBe(false);
  expect(fireEvent.click(link, { detail: 0 })).toBe(true);
  fireEvent.pointerDown(link);
  expect(fireEvent.click(link, { detail: 1 })).toBe(true);
});
