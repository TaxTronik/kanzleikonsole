import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: vi.fn() }));
import {
  DEFAULT_MODULES,
  type BooleanModuleKey,
  type ModuleConfig,
} from '@/server/settings/modules';
import { isModuleRouteEnabled, moduleRouteRequirement } from '@/server/settings/module-route-gate';
import {
  MODULE_AREAS,
  MODULE_AREA_KEYS,
  isModuleAreaEnabled,
  moduleAreaForPath,
  type ModuleAreaKey,
  type ModuleSurface,
} from '../module-registry';
import {
  clientNavigationDefinitions,
  mandateExpansionDefinitions,
  navigationDefinitions,
  resolvePortalNavigation,
  resolveStaffNavigation,
} from '../navigation-registry';

const BOOLEAN_KEYS = (Object.keys(DEFAULT_MODULES) as Array<keyof ModuleConfig>).filter(
  (key) => typeof DEFAULT_MODULES[key] === 'boolean',
) as BooleanModuleKey[];

function modules(on: ReadonlySet<string>): ModuleConfig {
  const config = { ...DEFAULT_MODULES } as Record<string, unknown>;
  for (const key of BOOLEAN_KEYS) config[key] = on.has(key);
  config['invoiceMode'] = on.has('invoices') ? 'IN_APP' : 'OFF';
  config['poaMode'] = on.has('poa') ? 'MARKDOWN_OTP' : 'OFF';
  return config as unknown as ModuleConfig;
}
const ALL_ON = modules(new Set([...BOOLEAN_KEYS, 'invoices', 'poa']));
const ALL_OFF = modules(new Set());

function surfaceOf(path: string): ModuleSurface {
  return path.startsWith('/portal/') ? 'portal' : 'staff';
}
/** Pfadmuster → konkreter Pfad (dynamische Segmente durch Beispielwerte). */
function concrete(path: string): string {
  return path.split('?')[0]!.replace(/\[[^\]]+\]/g, 'abc');
}
function requirementModules(area: ModuleAreaKey): string[] {
  const {
    all = [],
    any = [],
    modes = [],
  } = MODULE_AREAS[area].requires as {
    all?: readonly string[];
    any?: readonly string[];
    modes?: readonly string[];
  };
  return [...all, ...any, ...modes];
}
function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>(
    (acc, item) => acc.flatMap((subset) => [subset, [...subset, item]]),
    [[]],
  );
}

const NAV_REFERENCES: Array<{ label: string; module: ModuleAreaKey; href: string }> = [
  ...navigationDefinitions()
    .filter((item) => item.module)
    .map((item) => ({ label: item.id, module: item.module!, href: item.href })),
  ...clientNavigationDefinitions().map((item) => ({
    label: `client:${item.id}`,
    module: item.module,
    href: item.href,
  })),
  ...mandateExpansionDefinitions().map((item) => ({
    label: `expansion:${item.href}`,
    module: item.module,
    href: item.href,
  })),
];

describe('Modul-Registry – eine Quelle für Navigation, Route-Gate und Seiten', () => {
  it.each(MODULE_AREA_KEYS)('%s wird von Navigation und Route-Gate verwendet', (area) => {
    expect(
      NAV_REFERENCES.some((reference) => reference.module === area),
      `kein Navigationseintrag verweist auf ${area}`,
    ).toBe(true);
    for (const path of MODULE_AREAS[area].paths) {
      const surface = surfaceOf(path);
      expect(moduleAreaForPath(surface, concrete(path))).toBe(area);
      expect(moduleRouteRequirement(surface, `${concrete(path)}/unterseite`)).toBe(
        MODULE_AREAS[area].requires,
      );
      expect(isModuleRouteEnabled(ALL_OFF, surface, concrete(path))).toBe(false);
      expect(isModuleRouteEnabled(ALL_ON, surface, concrete(path))).toBe(true);
    }
  });

  it.each(NAV_REFERENCES.map((reference) => [reference.label, reference] as const))(
    '%s: Navigationsbereich = Bereich, den das Route-Gate für das Ziel prüft',
    (_label, reference) => {
      expect(moduleAreaForPath(surfaceOf(reference.href), concrete(reference.href))).toBe(
        reference.module,
      );
    },
  );

  it('Navigationsziele ohne Modulbereich sind auch im Route-Gate frei', () => {
    for (const item of navigationDefinitions().filter((definition) => !definition.module)) {
      expect(moduleAreaForPath(item.surface, item.href), item.id).toBeNull();
    }
  });

  it('Seitenleiste und Route-Gate stimmen für Admins in jeder Modulkombination überein', () => {
    const access = (config: ModuleConfig) => ({
      modules: config,
      isAdmin: true,
      permissions: ['PORTAL_INBOX_MANAGE', 'INBOUND_MAIL_MANAGE', 'PAYROLL_MANAGE'],
      portalFeatures: {
        clientInbox: true,
        bwaView: true,
        handoversView: true,
        stammdatenSelfService: true,
      },
    });
    for (const item of navigationDefinitions().filter((definition) => definition.module)) {
      const gated = moduleAreaForPath(item.surface, item.href);
      const relevant = new Set([
        ...requirementModules(item.module!),
        ...(gated ? requirementModules(gated) : []),
      ]);
      for (const on of subsets([...relevant])) {
        const config = modules(new Set(on));
        const groups =
          item.surface === 'staff'
            ? resolveStaffNavigation(access(config))
            : resolvePortalNavigation(access(config));
        const shown = groups.some((group) => group.items.some((entry) => entry.id === item.id));
        expect(shown, `${item.id} mit [${on.join(', ')}]`).toBe(
          isModuleRouteEnabled(config, item.surface, item.href),
        );
      }
    }
  });

  it('Kanzleikalender: Navigation und Gate verlangen Termine ODER Steuertermine', () => {
    for (const [on, expected] of [
      [['appointments'], true],
      [['taxNotices'], true],
      [[], false],
    ] as const) {
      const config = modules(new Set(on));
      const shown = resolveStaffNavigation({ modules: config })
        .flatMap((group) => group.items)
        .some((item) => item.href === '/staff/calendar');
      expect(shown).toBe(expected);
      expect(isModuleRouteEnabled(config, 'staff', '/staff/calendar')).toBe(expected);
    }
  });

  it('Jahreswechselkampagnen verlangen wie Seite und Actions auch das Formularmodul', () => {
    expect(isModuleAreaEnabled(modules(new Set(['yearEndCampaigns'])), 'yearEndCampaigns')).toBe(
      false,
    );
    expect(
      isModuleAreaEnabled(modules(new Set(['yearEndCampaigns', 'forms'])), 'yearEndCampaigns'),
    ).toBe(true);
  });

  it('wählt das spezifischste Muster unabhängig von der Reihenfolge', () => {
    expect(moduleAreaForPath('staff', '/staff/knowledge/context')).toBe('knowledgeContext');
    expect(moduleAreaForPath('staff', '/staff/knowledge/abc/edit')).toBe('knowledge');
    expect(moduleAreaForPath('staff', '/staff/mandate-expansion/vdb')).toBe('vdbPreparation');
    expect(moduleAreaForPath('staff', '/staff/mandate-expansion')).toBe('mandateExpansion');
    expect(moduleAreaForPath('staff', '/staff/clients/abc/bwa/plans/new')).toBe('bwa');
    expect(moduleAreaForPath('staff', '/staff/clients/abc/billing')).toBe('timeBilling');
    expect(moduleAreaForPath('staff', '/staff/timeline')).toBeNull();
    expect(moduleAreaForPath('staff', '/staff/clients/abc')).toBeNull();
    expect(moduleAreaForPath('portal', '/staff/time')).toBeNull();
  });
});
