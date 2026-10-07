// Fachkatalog: AUDIT-ARCHIVE-001, DSGVO-OPERATIONAL-RETENTION-001
// =============================================================================
// B14 (Review-Befund P-17): Rückstand der Wartungsjobs als Health-Kennzahl und
// Alarm. Abgedeckt:
//   - Schwelle: Läufe in Folge mit Rückstand ODER Alter des ältesten offenen
//     Eintrags seit Fälligkeit (benannte Konstante, als Parameter änderbar)
//   - Alarm: Hinweis an die aktiven ADMIN/PARTNER je betroffener Kanzlei mit
//     deren eigenen Zahlen, Mail an OPS_ALERT_EMAIL mit Gesamtzahlen ohne
//     Tenant-Bezug
//   - Dedupe: höchstens eine Mail je Job und UTC-Tag (Tagesmarke, bei
//     gescheitertem Versand wieder frei); Hinweise über den Upsert, dessen
//     Tagesgrenze der DB-Index setzt (packages/db notification-batch.test.ts)
//   - offene Hinweise werden geschlossen, sobald eine Kanzlei nicht mehr
//     betroffen ist; Fehler im Alarmweg brechen den Lauf nicht ab
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    env: { OPS_ALERT_EMAIL: 'ops@example.de' as string | undefined },
    store,
    ttl,
    redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
    openNotifications: vi.fn(),
    staffFindMany: vi.fn(),
    notify: vi.fn(),
    resolve: vi.fn(),
    sendOpsMail: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@taxtronik/config', () => ({ env: h.env }));
vi.mock('../queues', () => ({ connection: h.redis }));
vi.mock('../prisma-owner', () => ({
  prismaOwner: { notification: { findMany: h.openNotifications } },
}));
vi.mock('../tenant-context', () => ({
  withWorkerTenantContext: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ tenantId, staffUser: { findMany: h.staffFindMany } }),
}));
vi.mock('../notify', () => ({ notify: h.notify }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: h.resolve }));
vi.mock('../mailer', () => ({ sendOpsMail: h.sendOpsMail }));
vi.mock('../logger', () => ({ log: h.log }));

import {
  MAINTENANCE_BACKLOG_ALARM_THRESHOLD,
  describeThreshold,
  evaluateMaintenanceBacklog,
  formatSince,
  recordMaintenanceBacklog,
  type TenantBacklog,
} from '../maintenance-backlog';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-07T12:00:00.000Z');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';
const RUNS_AUDIT = 'taxtronik:maintenance-backlog:audit-rotate:runs';
const RUNS_ORPHANS = 'taxtronik:maintenance-backlog:storage-orphan-cleanup:runs';
const MAIL_AUDIT_TODAY = 'taxtronik:maintenance-backlog:audit-rotate:mail:2026-10-07';
const ADMINS: Record<string, Array<{ id: string }>> = {
  [TENANT_A]: [{ id: 'staff-a1' }, { id: 'staff-a2' }],
  [TENANT_C]: [{ id: 'staff-c1' }],
};

function backlog(tenantId: string, count: number, dueAgoMs: number | null): TenantBacklog {
  return {
    tenantId,
    count,
    oldestDueAt: dueAgoMs === null ? null : new Date(NOW.getTime() - dueAgoMs),
  };
}

function mailBodies(): string[] {
  return h.sendOpsMail.mock.calls.map((call) => `${call[0]}\n${call[1]}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.env.OPS_ALERT_EMAIL = 'ops@example.de';
  h.store.clear();
  h.ttl.clear();
  h.redis.get.mockImplementation(async (key: string) => h.store.get(key) ?? null);
  h.redis.set.mockImplementation(
    async (key: string, value: string, ...args: Array<string | number>) => {
      if (args.includes('NX') && h.store.has(key)) return null;
      h.store.set(key, value);
      const ex = args.indexOf('EX');
      if (ex >= 0) h.ttl.set(key, Number(args[ex + 1]));
      return 'OK';
    },
  );
  h.redis.del.mockImplementation(async (key: string) => (h.store.delete(key) ? 1 : 0));
  h.openNotifications.mockResolvedValue([]);
  h.staffFindMany.mockImplementation(
    async ({ where }: { where: { tenantId: string } }) => ADMINS[where.tenantId] ?? [],
  );
  h.notify.mockImplementation(async (_tx: unknown, inputs: unknown[]) => ({
    created: inputs.length,
    updated: 0,
  }));
  h.resolve.mockResolvedValue(1);
  h.sendOpsMail.mockResolvedValue(true);
});

describe('B14: Alarmschwelle', () => {
  it('ist eine benannte, unveränderliche Konstante: 3 Läufe in Folge oder älter als 7 Tage', () => {
    expect(MAINTENANCE_BACKLOG_ALARM_THRESHOLD).toEqual({
      consecutiveRuns: 3,
      maxOverdueMs: 7 * DAY,
    });
    expect(Object.isFrozen(MAINTENANCE_BACKLOG_ALARM_THRESHOLD)).toBe(true);
    expect(describeThreshold()).toBe(
      'Rückstand besteht nach 3 Läufen in Folge noch oder der älteste offene Eintrag ist ' +
        'seit mehr als 7 Tagen fällig',
    );
  });

  it.each([
    [0, false],
    [1, false],
    [2, true],
    [5, true],
  ])('zählt Läufe mit Rückstand (vorher %i) und alarmiert ab dem dritten', (previous, alarm) => {
    const young = { count: 4, oldestDueAt: new Date(NOW.getTime() - HOUR) };

    expect(evaluateMaintenanceBacklog(previous, young, NOW)).toEqual({
      consecutiveRuns: previous + 1,
      overdueMs: HOUR,
      alarm,
    });
  });

  it('beginnt ohne Rückstand von vorn', () => {
    expect(evaluateMaintenanceBacklog(7, { count: 0, oldestDueAt: null }, NOW)).toEqual({
      consecutiveRuns: 0,
      overdueMs: null,
      alarm: false,
    });
  });

  it('alarmiert schon im ersten Lauf, wenn der älteste Eintrag länger als 7 Tage fällig ist', () => {
    const at = (ageMs: number) => ({ count: 1, oldestDueAt: new Date(NOW.getTime() - ageMs) });

    expect(evaluateMaintenanceBacklog(0, at(7 * DAY), NOW).alarm).toBe(false);
    expect(evaluateMaintenanceBacklog(0, at(7 * DAY + 1), NOW).alarm).toBe(true);
  });

  it('ohne bekannte Fälligkeit zählt nur die Laufschwelle', () => {
    expect(evaluateMaintenanceBacklog(1, { count: 3, oldestDueAt: null }, NOW)).toEqual({
      consecutiveRuns: 2,
      overdueMs: null,
      alarm: false,
    });
  });

  it('wertet eine geänderte Schwelle ohne weitere Anpassung aus', () => {
    const threshold = { consecutiveRuns: 1, maxOverdueMs: 2 * HOUR };

    expect(
      evaluateMaintenanceBacklog(0, { count: 1, oldestDueAt: NOW }, NOW, threshold).alarm,
    ).toBe(true);
    expect(describeThreshold(threshold)).toBe(
      'Rückstand besteht nach 1 Lauf noch oder der älteste offene Eintrag ist seit mehr als ' +
        '2 Stunden fällig',
    );
  });

  it.each([
    [DAY, '1 Tag'],
    [9 * DAY + 5 * HOUR, '9 Tagen'],
    [HOUR, '1 Stunde'],
    [5 * HOUR, '5 Stunden'],
    [20 * 60 * 1000, '20 Minuten'],
    [1000, 'weniger als einer Minute'],
  ])('formatiert %i ms als „seit %s“', (ms, text) => {
    expect(formatSince(ms)).toBe(text);
  });
});

describe('B14: recordMaintenanceBacklog', () => {
  it('ohne Rückstand: setzt die Zählung zurück, schließt offene Hinweise, schickt keine Mail', async () => {
    h.store.set(RUNS_ORPHANS, '2');
    h.openNotifications.mockResolvedValue([{ tenantId: TENANT_A }]);

    const status = await recordMaintenanceBacklog('storageOrphanCleanup', [], NOW);

    expect(status).toEqual({
      count: 0,
      oldestDueAt: null,
      consecutiveRuns: 0,
      alarm: false,
      threshold: { consecutiveRuns: 3, maxOverdueMs: 7 * DAY },
    });
    expect(h.store.has(RUNS_ORPHANS)).toBe(false);
    expect(h.openNotifications).toHaveBeenCalledWith({
      where: { kind: 'SYSTEM_STORAGE_CLEANUP_BACKLOG', readAt: null },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }), {
      tenantId: TENANT_A,
      resources: [{ resourceType: 'tenant', resourceId: TENANT_A }],
      kinds: ['SYSTEM_STORAGE_CLEANUP_BACKLOG'],
    });
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.sendOpsMail).not.toHaveBeenCalled();
  });

  it('unter der Schwelle: zählt den Lauf mit, alarmiert aber nicht', async () => {
    h.store.set(RUNS_AUDIT, '1');

    const status = await recordMaintenanceBacklog(
      'auditRotate',
      [backlog(TENANT_A, 5, 2 * HOUR)],
      NOW,
    );

    expect(status).toMatchObject({ count: 5, consecutiveRuns: 2, alarm: false });
    expect(h.store.get(RUNS_AUDIT)).toBe('2');
    // Die Zählung muss einen wöchentlichen Lauf sicher überdauern.
    expect(h.ttl.get(RUNS_AUDIT)).toBeGreaterThan(7 * 24 * 60 * 60);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.sendOpsMail).not.toHaveBeenCalled();
  });

  it('ab der Schwelle: Hinweis an die aktiven ADMIN/PARTNER je betroffener Kanzlei, Mail ohne Tenant-Bezug', async () => {
    h.store.set(RUNS_AUDIT, '2');

    const status = await recordMaintenanceBacklog(
      'auditRotate',
      [
        backlog(TENANT_A, 4, 2 * DAY),
        backlog(TENANT_B, 0, null),
        backlog(TENANT_C, 12_000, 3 * HOUR),
      ],
      NOW,
    );

    expect(status).toEqual({
      count: 12_004,
      oldestDueAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      consecutiveRuns: 3,
      alarm: true,
      threshold: { consecutiveRuns: 3, maxOverdueMs: 7 * DAY },
    });
    // Empfänger: nur aktive ADMIN/PARTNER des jeweiligen Tenants.
    expect(h.staffFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_A,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(h.notify).toHaveBeenCalledTimes(2);
    type NotifyCall = [{ tenantId: string }, Array<Record<string, unknown>>];
    const [[txA, inputsA], [, inputsC]] = h.notify.mock.calls as unknown as [
      NotifyCall,
      NotifyCall,
    ];
    expect(txA.tenantId).toBe(TENANT_A);
    expect(inputsA).toEqual(
      ['staff-a1', 'staff-a2'].map((staffId) => ({
        tenantId: TENANT_A,
        staffId,
        kind: 'SYSTEM_AUDIT_ARCHIVE_BACKLOG',
        title: 'Wartungsrückstand: Audit-Archivierung',
        body:
          'Fällige, noch nicht archivierte Audit-Einträge Ihrer Kanzlei: 4 (ältester fällig ' +
          'seit 2 Tagen). Alarmschwelle: Rückstand besteht nach 3 Läufen in Folge noch oder ' +
          'der älteste offene Eintrag ist seit mehr als 7 Tagen fällig. Details unter System → Jobs.',
        href: '/staff/admin/jobs',
        resourceType: 'tenant',
        resourceId: TENANT_A,
      })),
    );
    // Jede Kanzlei sieht nur ihre eigenen Zahlen.
    expect(inputsC).toEqual([
      expect.objectContaining({
        tenantId: TENANT_C,
        staffId: 'staff-c1',
        resourceId: TENANT_C,
        body: expect.stringContaining('Ihrer Kanzlei: 12.000 (ältester fällig seit 3 Stunden)'),
      }),
    ]);

    expect(h.sendOpsMail).toHaveBeenCalledTimes(1);
    const [subject, body] = h.sendOpsMail.mock.calls[0] as [string, string];
    expect(subject).toBe('[TaxTronik] Wartungsrückstand: audit-rotate');
    expect(body).toContain('Offene fällige Einträge:      12.004');
    expect(body).toContain(
      `Ältester offener Eintrag:     fällig seit ${new Date(NOW.getTime() - 2 * DAY).toISOString()} (2 Tagen)`,
    );
    expect(body).toContain('Läufe in Folge mit Rückstand: 3');
    expect(body).toContain('Betroffene Kanzleien:         2');
    for (const tenantId of [TENANT_A, TENANT_B, TENANT_C]) expect(body).not.toContain(tenantId);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: 'audit-rotate',
        backlog: 12_004,
        notified: 3,
        mail: 'sent',
      }),
      'maintenance-backlog: Alarmschwelle erreicht',
    );
  });

  it('Dedupe: höchstens eine Mail je Job und UTC-Tag, am nächsten Tag wieder', async () => {
    const old = [backlog(TENANT_A, 4, 8 * DAY)];

    await recordMaintenanceBacklog('auditRotate', old, NOW);
    await recordMaintenanceBacklog('auditRotate', old, new Date(NOW.getTime() + 6 * HOUR));
    // Ein anderer Job hat seine eigene Tagesmarke.
    await recordMaintenanceBacklog('storageOrphanCleanup', old, NOW);

    expect(mailBodies()).toHaveLength(2);
    expect(h.ttl.get(MAIL_AUDIT_TODAY)).toBe(2 * 24 * 60 * 60);
    // Hinweise laufen bei jedem Alarmlauf über den Upsert (ungelesene werden
    // aktualisiert, neu angelegt wird höchstens einer je Tag: DB-Index).
    expect(h.notify).toHaveBeenCalledTimes(3);

    await recordMaintenanceBacklog('auditRotate', old, new Date('2026-10-08T00:30:00.000Z'));

    expect(mailBodies()).toHaveLength(3);
    expect(h.store.has('taxtronik:maintenance-backlog:audit-rotate:mail:2026-10-08')).toBe(true);
  });

  it('gibt den Tag nach gescheitertem Versand wieder frei, der nächste Lauf sendet erneut', async () => {
    const old = [backlog(TENANT_A, 4, 8 * DAY)];
    h.sendOpsMail.mockResolvedValueOnce(false);

    await recordMaintenanceBacklog('auditRotate', old, NOW);

    expect(h.store.has(MAIL_AUDIT_TODAY)).toBe(false);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mail: 'failed' }),
      'maintenance-backlog: Alarmschwelle erreicht',
    );

    await recordMaintenanceBacklog('auditRotate', old, new Date(NOW.getTime() + HOUR));

    expect(h.sendOpsMail).toHaveBeenCalledTimes(2);
    expect(h.store.has(MAIL_AUDIT_TODAY)).toBe(true);
  });

  it('ohne OPS_ALERT_EMAIL: kein Versand und keine Tagesmarke, der Hinweis geht trotzdem raus', async () => {
    h.env.OPS_ALERT_EMAIL = undefined;

    const status = await recordMaintenanceBacklog(
      'auditRotate',
      [backlog(TENANT_A, 4, 8 * DAY)],
      NOW,
    );

    expect(status.alarm).toBe(true);
    expect(h.sendOpsMail).not.toHaveBeenCalled();
    expect(h.store.has(MAIL_AUDIT_TODAY)).toBe(false);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('schließt Hinweise in Kanzleien, die nicht mehr betroffen sind, auch während des Alarms', async () => {
    h.openNotifications.mockResolvedValue([{ tenantId: TENANT_A }, { tenantId: TENANT_B }]);

    await recordMaintenanceBacklog('storageOrphanCleanup', [backlog(TENANT_A, 2, 8 * DAY)], NOW);

    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.resolve).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT_B,
      resources: [{ resourceType: 'tenant', resourceId: TENANT_B }],
      kinds: ['SYSTEM_STORAGE_CLEANUP_BACKLOG'],
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.anything(),
      ['staff-a1', 'staff-a2'].map((staffId) =>
        expect.objectContaining({
          tenantId: TENANT_A,
          staffId,
          kind: 'SYSTEM_STORAGE_CLEANUP_BACKLOG',
          title: 'Wartungsrückstand: Bereinigung verwaister Speicherobjekte',
          body: expect.stringContaining(
            'Fällige, noch nicht bereinigte Speicherobjekte Ihrer Kanzlei: 2 (ältester fällig seit 8 Tagen).',
          ),
        }),
      ),
    );
  });

  it('Fehler im Alarmweg brechen den Wartungslauf nicht ab und werden protokolliert', async () => {
    h.redis.get.mockRejectedValue(new Error('redis down'));
    h.redis.set.mockRejectedValue(new Error('redis down'));
    h.openNotifications.mockRejectedValue(new Error('db down'));
    h.notify.mockRejectedValue(new Error('db down'));

    const status = await recordMaintenanceBacklog(
      'auditRotate',
      [backlog(TENANT_A, 4, 8 * DAY)],
      NOW,
    );

    // Ohne Vorzustand zählt der Lauf als erster; die Altersschwelle alarmiert trotzdem.
    expect(status).toMatchObject({ count: 4, consecutiveRuns: 1, alarm: true });
    const steps = h.log.error.mock.calls.map((call) => (call[0] as { step: string }).step);
    expect(steps).toEqual(['state', 'state', 'resolve', 'notify', 'mail']);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'maintenance-backlog', queue: 'audit-rotate' }),
      'maintenance-backlog: Schritt fehlgeschlagen',
    );
  });
});
