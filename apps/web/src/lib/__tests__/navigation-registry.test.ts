import { describe, expect, it } from 'vitest';
import type { ModuleConfig } from '@/server/settings/modules';
import {
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
