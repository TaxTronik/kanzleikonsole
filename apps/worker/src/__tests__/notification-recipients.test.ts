// =============================================================================
// F-10: gemeinsamer Empfängerfilter für Ablauf-/Warnhinweise der Worker-Jobs.
// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withoutAccess: new Set<string>(),
  filter: vi.fn(),
  findAdmins: vi.fn(),
}));

vi.mock('@taxtronik/db/staff-client-access', () => ({
  filterStaffAccessClientTx: h.filter,
}));

import { resolveClientWarningRecipientsTx } from '../notification-recipients';

const tx = { staffUser: { findMany: h.findAdmins } } as never;
const base = { tenantId: 'tenant-1', clientId: 'client-1' };

beforeEach(() => {
  vi.resetAllMocks();
  h.withoutAccess.clear();
  h.filter.mockImplementation(
    async (_tx: unknown, _tenantId: string, ids: readonly string[]) =>
      new Set(ids.filter((id) => !h.withoutAccess.has(id))),
  );
  h.findAdmins.mockResolvedValue([{ id: 'admin-1' }, { id: 'partner-1' }]);
});

describe('resolveClientWarningRecipientsTx', () => {
  it('liefert aktive, berechtigte Zuständige in Übergabereihenfolge ohne Doppel', async () => {
    const recipients = await resolveClientWarningRecipientsTx(tx, {
      ...base,
      staffIds: ['hb-1', 'bt-1', 'hb-1', ''],
    });

    expect(recipients).toEqual(['hb-1', 'bt-1']);
    expect(h.filter).toHaveBeenCalledWith(tx, 'tenant-1', ['hb-1', 'bt-1'], 'client-1');
    // Ohne Fallbackbedarf wird ADMIN/PARTNER nicht gelesen.
    expect(h.findAdmins).not.toHaveBeenCalled();
  });

  it('fällt auf aktive ADMIN/PARTNER zurück, wenn alle Zuständigen ausgeschieden sind', async () => {
    h.withoutAccess.add('hb-1').add('bt-1');

    const recipients = await resolveClientWarningRecipientsTx(tx, {
      ...base,
      staffIds: ['hb-1', 'bt-1'],
    });

    expect(recipients).toEqual(['admin-1', 'partner-1']);
    expect(h.findAdmins).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(h.filter).toHaveBeenLastCalledWith(tx, 'tenant-1', ['admin-1', 'partner-1'], 'client-1');
  });

  it('ohne Zuständigkeit gilt derselbe Fallback', async () => {
    expect(await resolveClientWarningRecipientsTx(tx, { ...base, staffIds: [] })).toEqual([
      'admin-1',
      'partner-1',
    ]);
  });

  it('Eskalation ergänzt ADMIN/PARTNER, ohne Zuständige doppelt zu zählen', async () => {
    h.findAdmins.mockResolvedValue([{ id: 'admin-1' }, { id: 'hb-1' }]);

    const recipients = await resolveClientWarningRecipientsTx(tx, {
      ...base,
      staffIds: ['hb-1', 'bt-1'],
      includeAdminPartners: true,
    });

    expect(recipients).toEqual(['hb-1', 'bt-1', 'admin-1']);
  });

  it('liefert eine leere Liste, wenn niemand aktiv und berechtigt ist', async () => {
    h.withoutAccess.add('hb-1').add('admin-1').add('partner-1');

    expect(await resolveClientWarningRecipientsTx(tx, { ...base, staffIds: ['hb-1'] })).toEqual([]);
  });
});
