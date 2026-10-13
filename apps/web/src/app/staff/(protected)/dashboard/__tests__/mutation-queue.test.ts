// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@/server/dashboard/widgets';
import { createDashboardMutationQueue, snapshotForQueuedDashboardAdd } from '../mutation-queue';

const h = vi.hoisted(() => ({ save: vi.fn(), reset: vi.fn(), confirm: vi.fn() }));

vi.mock('../actions', () => ({
  addDashboardWidgetAction: vi.fn(),
  saveDashboardLayoutAction: h.save,
  resetDashboardLayoutAction: h.reset,
}));
vi.mock('@/components/ui/modal', () => ({ confirmDialog: h.confirm }));
vi.mock('../dashboard-grid-editor', () => ({ DashboardGridEditor: () => null }));

import { DashboardGrid } from '../dashboard-grid';

describe('Dashboard-Mutationsqueue', () => {
  it('laesst einen spaeteren Layout-Snapshot den vorherigen erst nach dessen Abschluss speichern', async () => {
    const queue = createDashboardMutationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = queue.enqueue(async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('setzt die Queue nach einem fehlgeschlagenen Save fort', async () => {
    const queue = createDashboardMutationQueue();
    const afterFailure: string[] = [];
    await expect(
      queue.enqueue(async () => {
        throw new Error('save failed');
      }),
    ).rejects.toThrow('save failed');

    await queue.enqueue(async () => {
      afterFailure.push('saved');
    });
    expect(afterFailure).toEqual(['saved']);
  });

  it('laesst einen fruehen Add-Snapshot kein spaeteres Pending-Widget persistieren', async () => {
    const queue = createDashboardMutationQueue();
    const a = { id: 'a' };
    const b = { id: 'b' };
    const live = [a, b];
    let persisted: Array<{ id: string }> = [];

    const first = queue.enqueue(async () => {
      persisted = snapshotForQueuedDashboardAdd(live, new Set(['a']));
    });
    const second = queue.enqueue(async () => {
      // Entspricht einem fehlgeschlagenen Render/Server-Action-Commit fuer B.
      throw new Error('widget b failed');
    });

    await first;
    await expect(second).rejects.toThrow('widget b failed');
    expect(persisted).toEqual([a]);
  });
});

// Standard-Reset im Dashboard als Verhaltenstest (B-08, Welle 15) statt
// Quelltextprüfung von dashboard-grid.tsx.
describe('Dashboard-Reset in der Mutationsqueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    vi.clearAllMocks();
    vi.useFakeTimers();
    h.confirm.mockResolvedValue(true);
    // Abgelehnter Reset: kein window.location.reload() in jsdom.
    h.reset.mockResolvedValue({ ok: false, error: 'Reset abgelehnt.' });
    render(
      createElement(DashboardGrid, {
        initialLayout: DEFAULT_LAYOUT,
        renderedWidgets: DEFAULT_LAYOUT.widgets.map((widget) => ({
          widget,
          node: createElement('div', null, `Inhalt ${widget.id}`),
        })),
        enabledWidgetTypes: DEFAULT_LAYOUT.widgets.map((widget) => widget.type),
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    });
    const form = screen.getByRole('form', { name: 'Mandanten: Position und Größe' });
    fireEvent.change(within(form).getByLabelText('Höhe (Rasterzeilen)'), {
      target: { value: '4' },
    });
    fireEvent.submit(form);
  }

  async function clickReset() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
    });
  }

  it('verwirft einen ausstehenden Debounce-Save beim Reset', async () => {
    await setup();
    await clickReset();
    expect(h.confirm).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert').textContent).toBe('Reset abgelehnt.');
  });

  it('reiht den Reset hinter einen laufenden Save ein und sperrt währenddessen', async () => {
    let finishSave!: (value: { ok: boolean }) => void;
    h.save.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
    await setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.save).toHaveBeenCalledOnce();

    await clickReset();
    expect(h.reset).not.toHaveBeenCalled();
    // Während des Resets: Bearbeitung geschlossen und gesperrt.
    expect(screen.queryByRole('form', { name: 'Mandanten: Position und Größe' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Anpassen' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => finishSave({ ok: true }));
    expect(h.reset).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Anpassen' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('setzt ohne Bestätigung nicht zurück', async () => {
    await setup();
    h.confirm.mockResolvedValueOnce(false);
    await clickReset();
    expect(h.reset).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(h.save).toHaveBeenCalledOnce();
  });
});
