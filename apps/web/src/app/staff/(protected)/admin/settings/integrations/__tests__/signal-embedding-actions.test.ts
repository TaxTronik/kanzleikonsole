import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  readModules: vi.fn(),
  embeddingRefresh: vi.fn(),
  embeddingSchedule: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
  logError: vi.fn(),
  riskLayerConfig: {
    url: 'http://signal.test',
    token: 'a'.repeat(32),
    operatorToken: 'b'.repeat(32) as string | undefined,
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/config', () => ({ riskLayerConfig: m.riskLayerConfig }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: class {
    embeddingRefresh = m.embeddingRefresh;
    embeddingSchedule = m.embeddingSchedule;
  },
}));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: m.staffActionGuard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));

import {
  triggerSignalEmbeddingAction,
  updateSignalEmbeddingScheduleAction,
} from '../signal-embedding-actions';

beforeEach(() => {
  vi.clearAllMocks();
  m.riskLayerConfig.operatorToken = 'b'.repeat(32);
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.readModules.mockResolvedValue({ signalEngine: true });
  m.withTenantContext.mockImplementation(
    async (_ctx: unknown, fn: (tx: { marker: string }) => unknown) => fn({ marker: 'tx' }),
  );
  m.embeddingRefresh.mockResolvedValue({
    ok: true,
    engineVersion: '1.4.0',
    job_id: 'embedding-job-1',
    state: 'queued',
  });
  m.embeddingSchedule.mockResolvedValue({
    ok: true,
    engineVersion: '1.4.0',
    schedule: {
      enabled: true,
      interval_days: 7,
      last_check_at: null,
      next_run_at: '2026-08-18T10:00:00Z',
    },
  });
});

describe('triggerSignalEmbeddingAction', () => {
  it('erzwingt den Refresh und auditiert erst nach Annahme durch Signal', async () => {
    const result = await triggerSignalEmbeddingAction();

    expect(m.staffActionGuard).toHaveBeenCalledWith({ requireAdmin: true });
    expect(m.embeddingRefresh).toHaveBeenCalledWith({ force: true });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      { marker: 'tx' },
      expect.objectContaining({
        action: 'risk.embedding.refresh.triggered',
        resourceType: 'signal_embedding',
        resourceId: 'embedding-job-1',
        after: { force: true, jobId: 'embedding-job-1', state: 'queued' },
      }),
    );
    expect(m.embeddingRefresh.mock.invocationCallOrder[0]).toBeLessThan(
      m.evidenceRecord.mock.invocationCallOrder[0]!,
    );
    expect(result).toEqual({
      ok: true,
      message: 'Die Embedding-Aktualisierung wurde eingeplant.',
      jobId: 'embedding-job-1',
      state: 'queued',
    });
  });

  it('gibt Engine-Fehler ohne technische Details zurück und auditiert sie nicht', async () => {
    m.embeddingRefresh.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:8000'));

    const result = await triggerSignalEmbeddingAction();

    expect(result).toEqual({
      ok: false,
      error: 'Die Signal-Engine konnte die Aktion nicht ausführen. Bitte später erneut versuchen.',
    });
    expect(JSON.stringify(result)).not.toContain('10.1.2.3');
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.logError).toHaveBeenCalledOnce();
  });
});

describe('updateSignalEmbeddingScheduleAction', () => {
  it('speichert ausschließlich den engen Wochenplan in Signal und auditiert die Antwort', async () => {
    const result = await updateSignalEmbeddingScheduleAction({ enabled: true, intervalDays: 7 });

    expect(m.embeddingSchedule).toHaveBeenCalledWith({ enabled: true, intervalDays: 7 });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      { marker: 'tx' },
      expect.objectContaining({
        action: 'risk.embedding.schedule.updated',
        resourceId: 'global-schedule',
        after: {
          enabled: true,
          intervalDays: 7,
          nextRunAt: '2026-08-18T10:00:00Z',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('sendet für Aus weiterhin das API-Pflichtintervall, aber deaktiviert den Plan', async () => {
    m.embeddingSchedule.mockResolvedValue({
      ok: true,
      engineVersion: '1.4.0',
      schedule: {
        enabled: false,
        interval_days: 7,
        last_check_at: null,
        next_run_at: null,
      },
    });

    const result = await updateSignalEmbeddingScheduleAction({ enabled: false });

    expect(m.embeddingSchedule).toHaveBeenCalledWith({ enabled: false, intervalDays: 7 });
    expect(result.message).toBe('Die automatische Aktualisierung ist ausgeschaltet.');
  });

  it('weist andere Intervalle vor dem Operator-Aufruf zurück', async () => {
    const result = await updateSignalEmbeddingScheduleAction({ enabled: true, intervalDays: 30 });

    expect(result).toEqual({ ok: false, error: 'Ungültiger Aktualisierungsplan.' });
    expect(m.embeddingSchedule).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('erzwingt Modul-Gate und Operator-Token auch bei direkten Action-Aufrufen', async () => {
    m.readModules.mockResolvedValueOnce({ signalEngine: false });
    expect(await updateSignalEmbeddingScheduleAction({ enabled: false })).toEqual({
      ok: false,
      error: 'Die Signal-Engine ist für diese Kanzlei nicht aktiviert.',
    });

    m.riskLayerConfig.operatorToken = undefined;
    expect(await updateSignalEmbeddingScheduleAction({ enabled: false })).toEqual({
      ok: false,
      error: 'Die Signal-Engine ist nur lesbar: Der Operator-Token ist nicht konfiguriert.',
    });
    expect(m.embeddingSchedule).not.toHaveBeenCalled();
  });
});
