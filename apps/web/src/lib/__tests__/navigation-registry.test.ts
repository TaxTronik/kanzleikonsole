import { describe, expect, it } from 'vitest';
import { activeNavHref } from '@/components/sidebar-nav';
import type { ModuleConfig } from '@/server/settings/modules';
import { isModuleRouteEnabled } from '@/server/settings/module-route-gate';
import {
  resolveClientNavigation,
  resolveMandateExpansionItems,
  resolvePortalNavigation,
  resolveStaffNavigation,
} from '../navigation-registry';

function moduleConfig(overrides: Partial<ModuleConfig> = {}): ModuleConfig {
  const values = {
    poaMode: 'OFF',
    invoiceMode: 'OFF',
    poaPdfTemplate: null,
    invoicePdfTemplate: null,
    subsumtionFloatingToolbarDefault: false,
    ...overrides,
  };
  return new Proxy(values, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return false;
    },
  }) as ModuleConfig;
}

const items = (groups: ReturnType<typeof resolveStaffNavigation>) =>
  groups.flatMap((group) => group.items);

describe('zentrale Navigation', () => {
  it('verwendet fuer geteilte Expansion-Ziele ein stabiles kanonisches Label', () => {
    const workflowOnly = items(
      resolveStaffNavigation({ modules: moduleConfig({ workflowDependencies: true }) }),
    );
    const structureOnly = items(
      resolveStaffNavigation({ modules: moduleConfig({ mandateStructure: true }) }),
    );
    expect(workflowOnly.find((item) => item.href === '/staff/mandate-expansion')?.label).toBe(
      'Mandatsorganisation',
    );
    expect(structureOnly.find((item) => item.href === '/staff/mandate-expansion')?.label).toBe(
      'Mandatsorganisation',
    );
  });

  it('zeigt den Offboarding-Hub und Administration nur Admins', () => {
    const employee = resolveStaffNavigation({
      modules: moduleConfig({ mandateOffboarding: true }),
      isAdmin: false,
    });
    expect(items(employee).some((item) => item.href === '/staff/mandate-expansion')).toBe(false);
    expect(employee.some((group) => group.id === 'administration')).toBe(false);

    const admin = resolveStaffNavigation({
      modules: moduleConfig({ mandateOffboarding: true }),
      isAdmin: true,
    });
    expect(items(admin).some((item) => item.href === '/staff/mandate-expansion')).toBe(true);
    expect(admin.some((group) => group.id === 'administration')).toBe(true);
  });

  it('liefert in der Expansion-Unternavigation nur aktivierte und berechtigte Ziele', () => {
    const modules = moduleConfig({
      mandateStructure: true,
      mandateOffboarding: true,
      vdbPreparation: false,
    });
    expect(resolveMandateExpansionItems(modules, false).map((item) => item.id)).toEqual([
      'structure',
    ]);
    expect(resolveMandateExpansionItems(modules, true).map((item) => item.id)).toEqual([
      'structure',
      'offboarding',
    ]);
  });

  it('bereitet Mandantenpost nur bei Feature und PORTAL_INBOX_MANAGE vor', () => {
    const denied = items(
      resolveStaffNavigation({
        modules: moduleConfig(),
        portalFeatures: { clientInbox: true },
      }),
    );
    const deniedFeature = items(
      resolveStaffNavigation({
        modules: moduleConfig(),
        permissions: ['PORTAL_INBOX_MANAGE'],
        portalFeatures: { clientInbox: false },
      }),
    );
    const allowed = items(
      resolveStaffNavigation({
        modules: moduleConfig(),
        permissions: ['PORTAL_INBOX_MANAGE'],
        portalFeatures: { clientInbox: true },
      }),
    );
    expect(denied.some((item) => item.href === '/staff/inbox')).toBe(false);
    expect(deniedFeature.some((item) => item.href === '/staff/inbox')).toBe(false);
    expect(allowed.find((item) => item.href === '/staff/inbox')?.label).toBe('Mandantenpost');
  });

  it('gated Modus-Module auf beiden Oberflaechen', () => {
    const off = moduleConfig({ invoiceMode: 'OFF' });
    expect(
      items(resolveStaffNavigation({ modules: off })).some((i) => i.href.endsWith('/invoices')),
    ).toBe(false);
    expect(
      resolvePortalNavigation({ modules: off, portalFeatures: {} })
        .flatMap((group) => group.items)
        .some((item) => item.href.endsWith('/invoices')),
    ).toBe(false);
  });

  it('zeigt die vorbereitete Portal-Inbox nur bei clientInbox', () => {
    const hidden = resolvePortalNavigation({
      modules: moduleConfig(),
      portalFeatures: { clientInbox: false },
    });
    const visible = resolvePortalNavigation({
      modules: moduleConfig(),
      portalFeatures: { clientInbox: true },
    });
    expect(hidden.flatMap((g) => g.items).some((item) => item.href === '/portal/inbox')).toBe(
      false,
    );
    expect(
      visible.flatMap((g) => g.items).find((item) => item.href === '/portal/inbox')?.label,
    ).toBe('Nachrichten');
  });

  it('Tax-CMS: Eintraege nur mit Modul UND konfiguriertem Dienst, Seiten bleiben erreichbar', () => {
    // Fachkatalog: TCMS-DIENST-001
    // TCMS Stufe 3: Modul an, Dienst nicht konfiguriert → kein Menüpunkt; das
    // Route-Gate lässt die Seite zu, die dann einen Hinweis statt eines
    // Fehlers zeigt (server/tcms/seite.ts).
    const an = moduleConfig({ tcms: true });
    const aus = moduleConfig({ tcms: false });
    const staff = (modules: ModuleConfig, tcms?: boolean) =>
      items(
        resolveStaffNavigation({ modules, ...(tcms === undefined ? {} : { dienste: { tcms } }) }),
      ).find((item) => item.href === '/staff/tcms');
    const portal = (modules: ModuleConfig, tcms?: boolean) =>
      resolvePortalNavigation({
        modules,
        portalFeatures: {},
        ...(tcms === undefined ? {} : { dienste: { tcms } }),
      })
        .flatMap((group) => group.items)
        .find((item) => item.href === '/portal/tcms');

    expect(staff(an, true)?.label).toBe('Tax-CMS');
    expect(portal(an, true)?.label).toBe('Tax-CMS');
    for (const [modules, tcms] of [
      [an, false],
      [an, undefined],
      [aus, true],
    ] as const) {
      expect(staff(modules, tcms)).toBeUndefined();
      expect(portal(modules, tcms)).toBeUndefined();
    }
    expect(
      resolveStaffNavigation({ modules: an, dienste: { tcms: true } }).find((group) =>
        group.items.some((item) => item.href === '/staff/tcms'),
      )?.id,
    ).toBe('mandates');
    expect(isModuleRouteEnabled(an, 'staff', '/staff/clients/abc/tcms/kontakte')).toBe(true);
    expect(isModuleRouteEnabled(aus, 'staff', '/staff/clients/abc/tcms')).toBe(false);
    expect(isModuleRouteEnabled(aus, 'portal', '/portal/tcms')).toBe(false);
  });

  it('Tax-CMS-Arbeitskorb und -Audit: Arbeitskorb für alle, Audit nur Admin/Partner, beide nur mit Dienst', () => {
    // Fachkatalog: TCMS-DIENST-001 (Integration Stufe 3: Navigation der Bereiche C und D)
    const an = moduleConfig({ tcms: true });
    const hrefs = (modules: ModuleConfig, isAdmin: boolean, tcms?: boolean) =>
      items(
        resolveStaffNavigation({
          modules,
          isAdmin,
          ...(tcms === undefined ? {} : { dienste: { tcms } }),
        }),
      ).map((item) => item.href);
    expect(hrefs(an, false, true)).toContain('/staff/tcms/arbeitskorb');
    expect(hrefs(an, false, true)).not.toContain('/staff/tcms/audit');
    expect(hrefs(an, true, true)).toContain('/staff/tcms/audit');
    for (const [modules, tcms] of [
      [an, false],
      [an, undefined],
      [moduleConfig({ tcms: false }), true],
    ] as const) {
      expect(hrefs(modules, true, tcms)).not.toContain('/staff/tcms/arbeitskorb');
      expect(hrefs(modules, true, tcms)).not.toContain('/staff/tcms/audit');
    }
    const gruppen = resolveStaffNavigation({ modules: an, isAdmin: true, dienste: { tcms: true } });
    const gruppeVon = (href: string) =>
      gruppen.find((g) => g.items.some((i) => i.href === href))?.id;
    expect(gruppeVon('/staff/tcms/arbeitskorb')).toBe('mandates');
    expect(gruppeVon('/staff/tcms/audit')).toBe('administration');
    // Genau ein aktiver Eintrag: der spezifischste; der Katalog bleibt beim Portfolio.
    const alle = gruppen.flatMap((g) => g.items);
    expect(activeNavHref(alle, '/staff/tcms/audit')).toBe('/staff/tcms/audit');
    expect(activeNavHref(alle, '/staff/tcms/arbeitskorb')).toBe('/staff/tcms/arbeitskorb');
    expect(activeNavHref(alle, '/staff/tcms/katalog')).toBe('/staff/tcms');
    expect(activeNavHref(alle, '/staff/tcms')).toBe('/staff/tcms');
  });

  it('Tax-CMS-Reiter der Mandantenakte nur mit Modul und konfiguriertem Dienst', () => {
    const an = moduleConfig({ tcms: true });
    expect(resolveClientNavigation(an, 'c 1', { tcms: true }).tcms).toBe(
      '/staff/clients/c%201/tcms',
    );
    expect(resolveClientNavigation(an, 'c1', { tcms: false }).tcms).toBeUndefined();
    expect(resolveClientNavigation(an, 'c1').tcms).toBeUndefined();
    expect(
      resolveClientNavigation(moduleConfig({ tcms: false }), 'c1', { tcms: true }).tcms,
    ).toBeUndefined();
    // „Subsumtion / TCMS“ (Modul risk) bleibt davon unberührt.
    expect(resolveClientNavigation(moduleConfig({ risk: true }), 'c1').subsumtion).toBe(
      '/staff/clients/c1/subsumtion',
    );
  });

  it('liefert je Oberflaeche eindeutige Ziele und IDs', () => {
    const resolved = resolveStaffNavigation({
      modules: moduleConfig({
        knowledge: true,
        knowledgeContext: true,
        noticeDecisions: true,
        feedbackSurveys: true,
        expenseAssistance: true,
        clientProcedures: true,
        mandateStructure: true,
        workflowDependencies: true,
      }),
      isAdmin: true,
    }).flatMap((group) => group.items);
    expect(new Set(resolved.map((item) => item.id)).size).toBe(resolved.length);
    expect(new Set(resolved.map((item) => item.href)).size).toBe(resolved.length);
  });
});
