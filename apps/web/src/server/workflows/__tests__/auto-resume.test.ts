// @vitest-environment jsdom
// Fachkatalog: WORKFLOW-LIFECYCLE-001.
// F-13: the timed resume itself (CAS, end-state evidence) moved to the worker job
// workflow-auto-resume and @taxtronik/db/workflow-lifecycle (tests there); the web
// only classifies elapsed pauses for display and must not write on render.
// Der Seitentest rendert die Workflow-Seite mit einer protokollierenden
// Transaktion statt ihren Quelltext zu lesen (B-08, Welle 15). Der Dateiname
// bleibt, weil die Regel ihn als test_ref führt.
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import { isPauseElapsed } from '../auto-resume';

const NOW = new Date('2026-10-05T08:00:00.000Z');

const h = vi.hoisted(() => ({
  calls: [] as string[],
  contexts: [] as string[],
  instances: [] as unknown[],
}));

/** Transaktion, die jeden Modellzugriff als „modell.methode" protokolliert. */
function recordingTx(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_inner, method: string) => async (args?: { where?: { status?: unknown } }) => {
              h.calls.push(`${model}.${method}`);
              if (model === 'client' && method === 'findUnique') {
                return { id: 'client-1', name: 'Muster GmbH' };
              }
              if (model === 'workflowInstance' && method === 'findMany') {
                const status = JSON.stringify(args?.where?.status ?? null);
                return status.includes('PAUSED') ? h.instances : [];
              }
              return method.startsWith('find') ? [] : { count: 0 };
            },
          },
        ),
    },
  );
}

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push('tenant');
    return fn(recordingTx());
  },
  withSystemContext: async (fn: (tx: unknown) => unknown) => {
    h.contexts.push('system');
    return fn(recordingTx());
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: async () => undefined }));
vi.mock('@/app/staff/(protected)/clients/[id]/workflows/actions', () => ({
  startInstanceAction: vi.fn(),
  cancelInstanceAction: vi.fn(),
  deleteCancelledInstanceAction: vi.fn(),
  pauseInstanceAction: vi.fn(),
  resumeInstanceAction: vi.fn(),
  restoreInstanceAction: vi.fn(),
  addItemToInstanceAction: vi.fn(),
  setWorkflowMembersAction: vi.fn(),
}));
vi.mock('@/app/staff/(protected)/clients/[id]/workflows/item-row', () => ({
  WorkflowItemRow: () => null,
}));

import ClientWorkflowsPage from '@/app/staff/(protected)/clients/[id]/workflows/page';

describe('F-13 elapsed pause display', () => {
  it('marks a paused instance whose resume date has passed', () => {
    expect(
      isPauseElapsed({ status: 'PAUSED', pausedUntil: new Date('2026-10-05T00:00:00Z') }, NOW),
    ).toBe(true);
    expect(isPauseElapsed({ status: 'PAUSED', pausedUntil: NOW }, NOW)).toBe(true);
  });

  it('keeps open-ended, future and non-paused instances as they are', () => {
    expect(isPauseElapsed({ status: 'PAUSED', pausedUntil: null }, NOW)).toBe(false);
    expect(
      isPauseElapsed({ status: 'PAUSED', pausedUntil: new Date('2026-10-06T00:00:00Z') }, NOW),
    ).toBe(false);
    expect(
      isPauseElapsed({ status: 'ACTIVE', pausedUntil: new Date('2026-10-01T00:00:00Z') }, NOW),
    ).toBe(false);
    expect(
      isPauseElapsed({ status: 'CANCELLED', pausedUntil: new Date('2026-10-01T00:00:00Z') }, NOW),
    ).toBe(false);
  });
});

describe('F-13 Workflow-Seite schreibt beim Rendern nicht', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h.calls.length = 0;
    h.contexts.length = 0;
    h.instances = [
      {
        id: 'instance-1',
        name: 'Jahresabschluss 2025',
        status: 'PAUSED',
        pausedUntil: new Date('2026-10-05T00:00:00Z'),
        startedAt: new Date('2026-09-01T00:00:00Z'),
        startedByStaff: 'staff-1',
        items: [],
        members: [],
      },
    ];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no longer resumes workflows while rendering the client workflow page', async () => {
    await renderServer(
      ClientWorkflowsPage({
        params: Promise.resolve({ id: 'client-1' }),
        searchParams: Promise.resolve({}),
      }),
    );

    // Die fällige Pause wird nur angezeigt; das Fortsetzen bleibt dem Worker.
    expect(screen.getByRole('heading', { name: 'Workflows' })).toBeTruthy();
    expect(screen.getByText('Jahresabschluss 2025')).toBeTruthy();
    expect(screen.getByText(/Pause abgelaufen – wird automatisch fortgesetzt/)).toBeTruthy();

    // Ausschließlich lesende Zugriffe im Mandantenkontext, kein Systemkontext.
    expect(h.calls).toContain('client.findUnique');
    expect(h.calls).toContain('workflowInstance.findMany');
    expect(
      h.calls.filter((call) => !/\.(findMany|findUnique|findFirst|count)$/.test(call)),
    ).toEqual([]);
    expect(h.contexts.every((context) => context === 'tenant')).toBe(true);
  });
});
