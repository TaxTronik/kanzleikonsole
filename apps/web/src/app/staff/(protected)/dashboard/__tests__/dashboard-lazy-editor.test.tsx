// @vitest-environment jsdom
// Dashboard: react-grid-layout samt Editor-CSS wird erst im Bearbeitungsmodus
// geladen (P-24/P-25). Verhaltenstest über Modul-Mocks, die nur beim
// tatsächlichen Import greifen (B-08, Welle 15); ersetzt die Quelltextprüfung
// der Imports aus dashboard-view-grid.test.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@/server/dashboard/widgets';

const h = vi.hoisted(() => ({ rgl: vi.fn(), editCss: vi.fn() }));

vi.mock('react-grid-layout', async (importOriginal) => {
  h.rgl();
  return importOriginal();
});
vi.mock('@/components/ui/grid-layout-edit.css', () => {
  h.editCss();
  return {};
});
vi.mock('../actions', () => ({
  addDashboardWidgetAction: vi.fn(),
  saveDashboardLayoutAction: vi.fn(),
  resetDashboardLayoutAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn() }));

import { DashboardGrid } from '../dashboard-grid';

describe('Dashboard: Editor nur im Bearbeitungsmodus', () => {
  it('rendert die Leseansicht ohne react-grid-layout und lädt Editor samt CSS beim Anpassen', async () => {
    render(
      <DashboardGrid
        initialLayout={DEFAULT_LAYOUT}
        renderedWidgets={DEFAULT_LAYOUT.widgets.map((widget) => ({
          widget,
          node: <div className="card">Inhalt {widget.id}</div>,
        }))}
        enabledWidgetTypes={DEFAULT_LAYOUT.widgets.map((widget) => widget.type)}
      />,
    );
    expect(screen.getByText('Inhalt w-1')).toBeTruthy();
    expect(h.rgl).not.toHaveBeenCalled();
    expect(h.editCss).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    });
    // Der Editor-Chunk wird erst jetzt importiert und transformiert (kalter Cache).
    await waitFor(
      () => {
        expect(h.rgl).toHaveBeenCalled();
        expect(h.editCss).toHaveBeenCalled();
      },
      { timeout: 10_000 },
    );
  });
});
