// Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001
// B14 (P-17): Rückstand der Wartungsjobs als Health-Kennzahl. Gelesen wird das
// Ergebnis des letzten erfolgreichen Laufs; das Alter des ältesten offenen
// Eintrags gilt zum Abfragezeitpunkt, ungültige oder alte Ergebnisse liefern
// keine erfundenen Werte, ein nicht lesbarer Status macht die Kennzahl
// „unknown“ statt „ok“.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  completed: new Map<string, unknown>(),
  getCompleted: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/server/logger', () => ({ log: { warn: h.warn } }));
vi.mock('../bullmq', () => ({
  WEB_QUEUE_TIMEOUT_MS: 2_000,
  getWebQueue: (name: string) => ({ getCompleted: () => h.getCompleted(name) }),
}));

import {
  MAINTENANCE_QUEUES,
  describeBacklogThreshold,
  getMaintenanceBacklogHealth,
  readBacklogStatus,
} from '../maintenance-backlog';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 12);
const THRESHOLD = { consecutiveRuns: 3, maxOverdueMs: 7 * DAY };
const STATUS = {
  count: 1_200,
  oldestDueAt: new Date(NOW - 9 * DAY).toISOString(),
  consecutiveRuns: 2,
  alarm: true,
  threshold: THRESHOLD,
};

beforeEach(() => {
  vi.resetAllMocks();
  h.completed.clear();
  h.getCompleted.mockImplementation(async (name: string) =>
    h.completed.has(name) ? [h.completed.get(name)] : [],
  );
});

describe('B14: readBacklogStatus', () => {
  it('liest die Kennzahl aus dem Job-Ergebnis', () => {
    expect(readBacklogStatus({ backlog: 1_200, backlogStatus: STATUS })).toEqual(STATUS);
    expect(
      readBacklogStatus({
        backlogStatus: { ...STATUS, count: 0, oldestDueAt: null, alarm: false },
      }),
    ).toEqual({ ...STATUS, count: 0, oldestDueAt: null, alarm: false });
  });

  it.each([
    undefined,
    null,
    'x',
    { backlog: 3 },
    { backlogStatus: null },
    { backlogStatus: { ...STATUS, count: -1 } },
    { backlogStatus: { ...STATUS, count: 1.5 } },
    { backlogStatus: { ...STATUS, oldestDueAt: 'gestern' } },
    { backlogStatus: { ...STATUS, consecutiveRuns: '2' } },
    { backlogStatus: { ...STATUS, alarm: 'ja' } },
    { backlogStatus: { ...STATUS, threshold: null } },
    { backlogStatus: { ...STATUS, threshold: { consecutiveRuns: 3 } } },
  ])('ignoriert ein fehlendes oder ungültiges Ergebnis (%o)', (returnvalue) => {
    expect(readBacklogStatus(returnvalue)).toBeNull();
  });
});

describe('B14: getMaintenanceBacklogHealth', () => {
  it('meldet je Wartungsjob Anzahl und Alter des ältesten offenen Eintrags zum Abfragezeitpunkt', async () => {
    h.completed.set('audit-rotate', {
      finishedOn: NOW - 3 * DAY,
      returnvalue: { backlog: 1_200, backlogStatus: STATUS },
    });
    h.completed.set('storage-orphan-cleanup', {
      finishedOn: NOW - 60_000,
      returnvalue: {
        backlog: 0,
        backlogStatus: { ...STATUS, count: 0, oldestDueAt: null, consecutiveRuns: 0, alarm: false },
      },
    });

    const health = await getMaintenanceBacklogHealth(NOW);

    expect(MAINTENANCE_QUEUES).toEqual(['audit-rotate', 'storage-orphan-cleanup']);
    expect(health).toEqual({
      status: 'alarm',
      jobs: [
        {
          queue: 'audit-rotate',
          readable: true,
          lastRunAt: new Date(NOW - 3 * DAY).toISOString(),
          backlog: 1_200,
          oldestPendingDueAt: STATUS.oldestDueAt,
          // Der Lauf ist drei Tage alt, das Alter gilt für jetzt.
          oldestPendingAgeMs: 9 * DAY,
          consecutiveRuns: 2,
          alarm: true,
          threshold: THRESHOLD,
        },
        {
          queue: 'storage-orphan-cleanup',
          readable: true,
          lastRunAt: new Date(NOW - 60_000).toISOString(),
          backlog: 0,
          oldestPendingDueAt: null,
          oldestPendingAgeMs: null,
          consecutiveRuns: 0,
          alarm: false,
          threshold: THRESHOLD,
        },
      ],
    });
    // Keine Tenant-Angaben in der Health-Ausgabe.
    expect(JSON.stringify(health)).not.toMatch(/tenant/i);
  });

  it('ohne Alarm „ok“; ein Ergebnis von vor B14 liefert nur die Anzahl, ohne Lauf nichts', async () => {
    h.completed.set('audit-rotate', { finishedOn: NOW - DAY, returnvalue: { backlog: 7 } });

    const health = await getMaintenanceBacklogHealth(NOW);

    expect(health.status).toBe('ok');
    expect(health.jobs[0]).toMatchObject({
      backlog: 7,
      oldestPendingDueAt: null,
      oldestPendingAgeMs: null,
      consecutiveRuns: null,
      alarm: false,
      threshold: null,
    });
    expect(health.jobs[1]).toMatchObject({ readable: true, lastRunAt: null, backlog: null });
  });

  it('ein nicht lesbarer Status macht die Kennzahl „unknown“ und wird protokolliert', async () => {
    h.getCompleted.mockImplementation(async (name: string) => {
      if (name === 'storage-orphan-cleanup') throw new Error('redis down');
      return [];
    });

    const health = await getMaintenanceBacklogHealth(NOW);

    expect(health.status).toBe('unknown');
    expect(health.jobs[1]).toMatchObject({ queue: 'storage-orphan-cleanup', readable: false });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'storage-orphan-cleanup', err: 'redis down' }),
      'status read failed',
    );
  });
});

describe('B14: describeBacklogThreshold', () => {
  it('beschreibt die Schwelle für die Jobübersicht', () => {
    expect(describeBacklogThreshold(THRESHOLD)).toBe(
      'Rückstand nach 3 Läufen in Folge oder ältester offener Eintrag seit mehr als 7 Tagen fällig',
    );
    expect(
      describeBacklogThreshold({ consecutiveRuns: 1, maxOverdueMs: 36 * 60 * 60 * 1000 }),
    ).toBe('Rückstand nach 1 Lauf oder ältester offener Eintrag seit mehr als 36 Stunden fällig');
  });
});
