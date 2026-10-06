import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  portalAuth: vi.fn(),
  readModules: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
}));

vi.mock('next/navigation', () => ({ notFound: m.notFound, redirect: m.redirect }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: m.portalAuth }));
vi.mock('../modules', () => ({ readModules: m.readModules }));

import { requireModulePage } from '../module-page';

const STAFF = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } };
const PORTAL = { user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue(STAFF);
  m.portalAuth.mockResolvedValue(PORTAL);
});

describe('requireModulePage – Seiten-Gate aus der Modul-Registry', () => {
  it.each([
    ['staff', 'phoneNotes', { phoneNotes: false }],
    ['staff', 'timeTracking', { timeTracking: false }],
    ['staff', 'knowledge', { knowledge: false }],
    ['staff', 'timeBilling', { timeTracking: true, invoiceMode: 'OFF' }],
    ['staff', 'officeCalendar', { appointments: false, taxNotices: false }],
    ['staff', 'yearEndCampaigns', { yearEndCampaigns: true, forms: false }],
    ['portal', 'handovers', { handovers: false }],
    ['portal', 'invoices', { invoiceMode: 'OFF' }],
  ] as const)(
    'ein deaktiviertes Modul sperrt den direkten Seitenaufruf (%s, %s)',
    async (surface, area, config) => {
      m.readModules.mockResolvedValue(config);
      await expect(requireModulePage(surface, area)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(m.notFound).toHaveBeenCalledOnce();
    },
  );

  it('liefert bei aktivem Modul die Modulkonfiguration (Staff-Kontext)', async () => {
    const config = { appointments: true, taxNotices: false };
    m.readModules.mockResolvedValue(config);

    await expect(requireModulePage('staff', 'officeCalendar')).resolves.toBe(config);
    expect(m.readModules).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorId: 'staff-1',
      actorType: 'STAFF',
    });
    expect(m.portalAuth).not.toHaveBeenCalled();
  });

  it('liest im Portal mit dem Kontakt als Akteur', async () => {
    m.readModules.mockResolvedValue({ bwa: true });

    await requireModulePage('portal', 'bwa');
    expect(m.readModules).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      actorId: 'contact-1',
      actorType: 'CLIENT_CONTACT',
    });
    expect(m.staffAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['staff', '/staff/login'],
    ['portal', '/portal/login'],
  ] as const)(
    'leitet ohne Sitzung zum Login (%s), ohne Module zu lesen',
    async (surface, target) => {
      m.staffAuth.mockResolvedValue(null);
      m.portalAuth.mockResolvedValue(null);

      await expect(requireModulePage(surface, 'forms')).rejects.toThrow(`redirect:${target}`);
      expect(m.readModules).not.toHaveBeenCalled();
    },
  );
});
