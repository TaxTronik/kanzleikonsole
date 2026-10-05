// =============================================================================
// Unit-Tests: sanctions-refresh (P-16, F-05).
// Fachkatalog: GWG-SCREENING-001, ACCESS-NOTIFICATION-RECIPIENT-001
//
// Die Liste wird einmal je Lauf vorbereitet; Hinweise je Mandant nur bei
// Namenskandidaten, sonst höchstens ein Sammelhinweis je Tenant; Fehler werden
// protokolliert und lassen den Lauf scheitern. Gleiche Trefferergebnisse belegt
// packages/tax/src/screening/prepared.test.ts.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    sanctionsSourceState: { upsert: vi.fn() },
    staffUser: { findMany: vi.fn() },
  };
  return {
    tx,
    tenants: vi.fn(),
    modules: vi.fn(),
    notify: vi.fn(),
    filter: vi.fn(),
    record: vi.fn(),
    prepare: vi.fn(),
    fetch: vi.fn(),
    store: vi.fn(),
    followup: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../../prisma-owner', () => ({ prismaOwner: { tenant: { findMany: h.tenants } } }));
vi.mock('../../tenant-context', () => ({
  withWorkerTenantContext: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(h.tx),
}));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/db/tenant-modules', () => ({ readBooleanTenantModules: h.modules }));
vi.mock('@taxtronik/db/notification', () => ({ upsertNotificationTx: h.notify }));
vi.mock('@taxtronik/db/staff-client-access', () => ({ filterStaffAccessClientTx: h.filter }));
vi.mock('@taxtronik/evidence', () => ({
  EvidenceService: class {
    record = h.record;
  },
  LocalTimestampAdapter: class {},
}));
vi.mock('@taxtronik/tax', () => ({ prepareEuList: h.prepare }));
vi.mock('@taxtronik/tax/screening/source', () => ({ fetchEuSanctions: h.fetch }));
vi.mock('@taxtronik/tax/screening/persistence', () => ({
  storeSanctionsSnapshot: h.store,
  followupSanctions: h.followup,
}));

import { runSanctionsRefresh } from '../sanctions-refresh';

const PREPARED = { kind: 'prepared-eu-list', entries: [] };
const DOWNLOADED = { sha256: 'b'.repeat(64), entries: [{ id: 'eu-1' }] };

function notifications() {
  return h.notify.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.tenants.mockResolvedValue([{ id: 'tenant-1' }]);
  h.modules.mockResolvedValue({ sanctionsScreening: true });
  h.fetch.mockResolvedValue(DOWNLOADED);
  h.prepare.mockReturnValue(PREPARED);
  h.store.mockResolvedValue({
    snapshot: { id: 'snapshot-2', sha256: 'b'.repeat(64) },
    changed: true,
  });
  h.followup.mockResolvedValue({ created: [], nextCursor: null });
  h.tx.staffUser.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'partner-1' }]);
  h.filter.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) => new Set(ids),
  );
});

describe('P-16: Folgeläufe mit vorbereiteter Liste', () => {
  it('bereitet die Liste einmal je Lauf vor und nutzt sie für alle Tenants', async () => {
    h.tenants.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);

    await runSanctionsRefresh();

    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.prepare).toHaveBeenCalledWith(DOWNLOADED.entries);
    expect(h.followup.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ['tenant-1', 'snapshot-2', PREPARED],
      ['tenant-2', 'snapshot-2', PREPARED],
    ]);
  });

  it('meldet Treffer je Mandant und fasst Läufe ohne Kandidaten in einem Hinweis zusammen', async () => {
    h.followup
      .mockResolvedValueOnce({
        created: [
          { id: 'run-1', clientId: 'client-1', candidates: true },
          { id: 'run-2', clientId: 'client-2', candidates: false },
        ],
        nextCursor: 'root-10',
      })
      .mockResolvedValueOnce({
        created: [{ id: 'run-3', clientId: 'client-3', candidates: false }],
        nextCursor: null,
      });
    h.filter.mockImplementation(
      async (_tx: unknown, _tenantId: string, ids: readonly string[]) =>
        new Set(ids.filter((id) => id === 'admin-1')),
    );

    await expect(runSanctionsRefresh()).resolves.toEqual({ tenants: 1, runs: 3, failed: 0 });

    expect(h.followup.mock.calls.map((call) => call[4])).toEqual([undefined, 'root-10']);
    // Jeder Folgelauf bleibt ein eigener Audit-Nachweis.
    expect(
      h.record.mock.calls.filter((call) => call[1].action === 'screening.run.followup'),
    ).toHaveLength(3);
    expect(notifications()).toEqual([
      expect.objectContaining({
        staffId: 'admin-1',
        clientId: 'client-1',
        kind: 'SCREENING_REVIEW',
        resourceType: 'client',
        resourceId: 'client-1',
        title: 'EU-Screening: neue Trefferhinweise prüfen',
      }),
      ...['admin-1', 'partner-1'].map((staffId) =>
        expect.objectContaining({
          staffId,
          kind: 'SCREENING_REVIEW',
          resourceType: 'tenant',
          resourceId: 'tenant-1',
          title: 'EU-Screening: 2 Folgeprüfungen ohne Namenshinweis',
          href: '/staff/admin/screening',
        }),
      ),
    ]);
    expect(notifications().some((entry) => entry['clientId'] === 'client-2')).toBe(false);
  });

  it('erzeugt bei unverändertem, vollständig abgearbeitetem Stand keine Hinweise', async () => {
    h.store.mockResolvedValue({ snapshot: { id: 'snapshot-1', sha256: 'a' }, changed: false });

    await expect(runSanctionsRefresh()).resolves.toEqual({ tenants: 1, runs: 0, failed: 0 });

    expect(h.followup).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.tx.staffUser.findMany).not.toHaveBeenCalled();
  });
});

describe('F-05: Fehler werden protokolliert und lassen den Lauf scheitern', () => {
  it('Abruf scheitert: Fehler loggen, Quellenstand je Tenant vermerken, Lauf scheitert', async () => {
    h.fetch.mockRejectedValue(new Error('HTTP 503'));

    await expect(runSanctionsRefresh()).rejects.toThrow('EU sanctions refresh failed');

    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'HTTP 503' }),
      expect.stringContaining('EU-Abruf'),
    );
    expect(h.tx.sanctionsSourceState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastError: 'Täglicher EU-Abruf / Validierung fehlgeschlagen.',
        }),
      }),
    );
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('Tenant scheitert: Fehler mit Tenant loggen, übrige Tenants weiter, Lauf scheitert', async () => {
    h.tenants.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    h.store.mockRejectedValueOnce(new Error('EU-Stand älter oder Rückgang über 20 %'));

    await expect(runSanctionsRefresh()).rejects.toThrow('incomplete for 1 tenants');

    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        err: 'EU-Stand älter oder Rückgang über 20 %',
      }),
      expect.stringContaining('Folgeprüfungen fehlgeschlagen'),
    );
    expect(h.followup).toHaveBeenCalledWith(h.tx, 'tenant-2', 'snapshot-2', PREPARED, undefined);
  });
});
