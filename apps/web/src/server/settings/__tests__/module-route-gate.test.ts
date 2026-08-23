import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: vi.fn() }));
import { DEFAULT_MODULES, type BooleanModuleKey } from '../modules';
import { isModuleRouteEnabled, moduleRouteRequirement } from '../module-route-gate';

describe('tenantweite Modul-Routen', () => {
  it.each<[BooleanModuleKey, 'staff' | 'portal', string]>([
    ['bwa', 'staff', '/staff/clients/abc/bwa/2026'],
    ['knowledge', 'staff', '/staff/knowledge/new'],
    ['timeTracking', 'staff', '/staff/time'],
    ['timeTracking', 'staff', '/staff/clients/abc/billing'],
    ['phoneNotes', 'staff', '/staff/phone-notes'],
    ['taxNotices', 'staff', '/staff/clients/abc/notices/new'],
    ['workflows', 'staff', '/staff/clients/abc/workflows/def'],
    ['forms', 'portal', '/portal/forms/abc'],
    ['reminders', 'staff', '/staff/reminders/abc'],
    ['handovers', 'portal', '/portal/handovers'],
    ['appointments', 'portal', '/portal/appointments'],
    ['risk', 'staff', '/staff/clients/abc/subsumtion/new'],
  ])('sperrt %s bei direktem Seitenaufruf', (moduleKey, surface, pathname) => {
    expect(
      isModuleRouteEnabled({ ...DEFAULT_MODULES, [moduleKey]: false }, surface, pathname),
    ).toBe(false);
  });

  it.each([
    ['staff', '/staff/invoices/abc', 'invoiceMode'],
    ['staff', '/staff/admin/invoice-categories', 'invoiceMode'],
    ['portal', '/portal/invoices', 'invoiceMode'],
    ['staff', '/staff/poa/abc', 'poaMode'],
  ] as const)('sperrt %s %s bei OFF-Betriebsmodus', (surface, pathname, mode) => {
    expect(isModuleRouteEnabled({ ...DEFAULT_MODULES, [mode]: 'OFF' }, surface, pathname)).toBe(
      false,
    );
  });

  it('verlangt für die Stundenabrechnung Zeit- und Rechnungsmodul zugleich', () => {
    expect(
      isModuleRouteEnabled(
        { ...DEFAULT_MODULES, timeTracking: true, invoiceMode: 'OFF' },
        'staff',
        '/staff/clients/abc/billing',
      ),
    ).toBe(false);
  });

  it('erlaubt den gemischten Kanzleikalender, wenn mindestens ein Teilmodul aktiv ist', () => {
    expect(
      isModuleRouteEnabled(
        { ...DEFAULT_MODULES, taxNotices: false, appointments: true },
        'staff',
        '/staff/calendar',
      ),
    ).toBe(true);
    expect(
      isModuleRouteEnabled(
        { ...DEFAULT_MODULES, taxNotices: false, appointments: false },
        'staff',
        '/staff/calendar',
      ),
    ).toBe(false);
  });

  it('ordnet Partial-Module ohne eigene Seite bewusst keiner Ganzseiten-Sperre zu', () => {
    for (const moduleKey of ['binders', 'rssReader', 'inboundMail', 'signalEngine'] as const) {
      expect(moduleRouteRequirement('staff', `/staff/dashboard?module=${moduleKey}`)).toBeNull();
    }
  });
});
