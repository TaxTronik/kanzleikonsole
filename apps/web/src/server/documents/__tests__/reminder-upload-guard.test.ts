import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

const access = vi.hoisted(() => ({ assertClientAccessTx: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: access.assertClientAccessTx,
  isStaffAdmin: (session: StaffSession) => session.user.roles.includes('ADMIN'),
  ForbiddenError: class extends Error {},
}));

import { ForbiddenError } from '@/server/auth/rbac';
import { assertReminderUploadTx, ReminderUploadError } from '../reminder-upload-guard';

const session = {
  user: { tenantId: 'tenant', staffId: 'staff', roles: ['MITARBEITER'] },
} as StaffSession;

function setup(overrides: Record<string, unknown> = {}) {
  const row = {
    clientId: null,
    createdByStaff: 'staff',
    assignees: [],
    archivedAt: null,
    ...overrides,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'reminder' }]),
    clientReminder: { findFirst: vi.fn().mockResolvedValue(row) },
  };
  return {
    tx,
    run: (clientId: string | null = null) =>
      assertReminderUploadTx(tx as unknown as TxClient, session, 'reminder', clientId),
  };
}

// Fachkatalog: REMINDER-TICKET-001, ACCESS-CLIENT-MODE-001
describe('Anhänge an Wiedervorlagen', () => {
  beforeEach(() => vi.resetAllMocks());

  it('sperrt die Zeile vor dem Zustandsread und erlaubt eine eigene interne Aufgabe', async () => {
    const { tx, run } = setup();
    await run();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.clientReminder.findFirst.mock.invocationCallOrder[0]!,
    );
    const [sql, id, tenantId] = tx.$queryRaw.mock.calls[0]!;
    expect(sql.join('')).toContain('FOR NO KEY UPDATE');
    expect([id, tenantId]).toEqual(['reminder', 'tenant']);
    expect(tx.clientReminder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'reminder', tenantId: 'tenant' } }),
    );
  });

  it('verweigert fremde interne Aufgaben auch bei bekanntem Ticketlink', async () => {
    await expect(setup({ createdByStaff: 'other' }).run()).rejects.toBeInstanceOf(
      ReminderUploadError,
    );
  });

  it('erlaubt aktuell zugewiesene Personen', async () => {
    await setup({ createdByStaff: 'other', assignees: [{ staffId: 'staff' }] }).run();
  });

  it('prüft aktuelle Mandantenrechte und verbirgt die Ablehnungsdetails', async () => {
    access.assertClientAccessTx.mockRejectedValue(new ForbiddenError('Vertrauliches Mandat'));
    await expect(setup({ clientId: 'client' }).run('client')).rejects.toThrow(
      'Wiedervorlage nicht verfügbar oder bereits archiviert.',
    );
  });

  it('verweigert archivierte Tickets und Mandantenwechsel', async () => {
    await expect(setup({ archivedAt: new Date() }).run()).rejects.toBeInstanceOf(
      ReminderUploadError,
    );
    await expect(setup({ clientId: 'other' }).run('client')).rejects.toBeInstanceOf(
      ReminderUploadError,
    );
  });

  it('erkennt die Archivierung zwischen Vorprüfung und Finalisierung', async () => {
    const { tx, run } = setup();
    await run();
    tx.clientReminder.findFirst.mockResolvedValueOnce({
      clientId: null,
      createdByStaff: 'staff',
      assignees: [],
      archivedAt: new Date(),
    });
    await expect(run()).rejects.toBeInstanceOf(ReminderUploadError);
  });

  it('maskiert unerwartete Datenbankfehler nicht als fehlende Rechte', async () => {
    const error = new Error('database unavailable');
    access.assertClientAccessTx.mockRejectedValue(error);
    await expect(setup({ clientId: 'client' }).run('client')).rejects.toBe(error);
  });
});
