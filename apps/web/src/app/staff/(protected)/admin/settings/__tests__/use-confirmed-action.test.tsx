// Gemeinsamer Bestätigungsablauf irreversibler n8n-Admin-Aktionen: Reihenfolge
// Bestätigung → Pending → Transition → Action → Ergebnis, Abbruch ohne Wirkung.

import type { TransitionStartFunction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock('@/components/ui/modal', () => ({ confirmDialog }));

import { useConfirmedAction } from '../use-confirmed-action';

type Confirmation = string | null | ((id: string) => string | null);

let confirmResult = true;

function confirmedAction(confirmation: Confirmation) {
  const calls: string[] = [];
  const action = vi.fn(async (id: string) => {
    calls.push(`action:${id}`);
    return { ok: true, id };
  });
  const startTransition = vi.fn((callback: () => unknown) => {
    calls.push('transition');
    return callback();
  }) as unknown as TransitionStartFunction;
  let run: ((id: string) => void) | undefined;

  function Probe() {
    run = useConfirmedAction<[string], { ok: boolean; id: string }>({
      startTransition,
      confirmation,
      action,
      onPending: (id) => calls.push(`pending:${id}`),
      onResult: (result, id) => calls.push(`result:${result.id}:${id}`),
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  confirmDialog.mockImplementation(async (message: string) => {
    calls.push(`confirm:${message}`);
    return confirmResult;
  });
  return { run: run!, calls, action, startTransition };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmResult = true;
});

describe('useConfirmedAction', () => {
  it('fragt zuerst nach und startet die Action erst danach in der Transition', async () => {
    const { run, calls } = confirmedAction('Route löschen?');

    run('endpoint-1');
    await settle();

    expect(calls).toEqual([
      'confirm:Route löschen?',
      'pending:endpoint-1',
      'transition',
      'action:endpoint-1',
      'result:endpoint-1:endpoint-1',
    ]);
  });

  it('bleibt bei Abbruch ohne Pending-Zustand, Transition und Action', async () => {
    confirmResult = false;
    const { run, calls, action, startTransition } = confirmedAction('Zustellung quittieren?');

    run('delivery-1');
    await settle();

    expect(calls).toEqual(['confirm:Zustellung quittieren?']);
    expect(action).not.toHaveBeenCalled();
    expect(startTransition).not.toHaveBeenCalled();
  });

  it('leitet die Rückfrage aus den Argumenten ab oder überspringt sie', async () => {
    const derived = confirmedAction((id) => (id === 'skip' ? null : `Event ${id} verwerfen?`));
    derived.run('outbox-7');
    derived.run('skip');
    await settle();

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog).toHaveBeenCalledWith('Event outbox-7 verwerfen?');
    expect(derived.action).toHaveBeenCalledWith('outbox-7');
    expect(derived.action).toHaveBeenCalledWith('skip');

    vi.clearAllMocks();
    const silent = confirmedAction(null);
    silent.run('endpoint-2');
    await settle();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(silent.calls).toEqual([
      'pending:endpoint-2',
      'transition',
      'action:endpoint-2',
      'result:endpoint-2:endpoint-2',
    ]);
  });
});
