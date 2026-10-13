// @vitest-environment jsdom
// Benutzerverwaltung: responsives Layout als Render-Test (B-08, Welle 15)
// statt Quelltextprüfung. Geprüft werden die gerenderten Klassen und das
// Verhalten des Tätigkeiten-Dialogs (Portal außerhalb der Tabellenkarte).
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import { STAFF_PERMISSIONS } from '@/lib/staff-permissions';

const h = vi.hoisted(() => ({ users: [] as Array<Record<string, unknown>> }));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-admin', roles: ['ADMIN'] },
  })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      staffUser: { findMany: vi.fn(async () => h.users) },
      staffSkill: {
        findMany: vi.fn(async () => [{ id: 'skill-1', label: 'Lohn', color: 'blue' }]),
      },
      client: { findMany: vi.fn(async () => []) },
    }),
  ),
}));
vi.mock('../actions', () => ({
  beginHardwareRecoveryStepUpAction: vi.fn(),
  recoverHardwareAccessAction: vi.fn(),
  resetPasswordAction: vi.fn(),
  resetTotpAction: vi.fn(),
  setActiveAction: vi.fn(),
  setRolesAction: vi.fn(),
  setPermissionsAction: vi.fn(),
  setProfessionalProfileAction: vi.fn(),
}));
vi.mock('../../skills/actions', () => ({ setStaffSkillsAction: vi.fn() }));
vi.mock('../create-form', () => ({ CreateUserForm: () => null }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }));

import UsersAdminPage from '../page';

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    fullName: `Person ${id}`,
    email: `${id}@kanzlei.example`,
    active: true,
    roles: [{ role: 'EMPLOYEE' }],
    permissions: [],
    skillAssignments: [],
    hardwareCredentials: [],
    hardwareOnlyEnabledAt: null,
    isProfessional: false,
    datevAdvisorNumber: null,
    professionalQualificationSource: null,
    totpEnrolledAt: new Date('2026-01-01T00:00:00.000Z'),
    totpSecretEnc: 'enc',
    totpSetupStartedAt: null,
    totpBackupCodes: [],
    lastLoginAt: null,
    ...overrides,
  };
}

async function render() {
  return renderServer(UsersAdminPage());
}

function row(name: string): HTMLTableRowElement {
  return screen.getByText(name).closest('tr') as HTMLTableRowElement;
}

beforeEach(() => {
  h.users = [
    user('staff-admin', { fullName: 'Ada Admin', roles: [{ role: 'ADMIN' }] }),
    user('active', { fullName: 'Aktive Person' }),
    user('inactive', { fullName: 'Inaktive Person', active: false }),
  ];
});

describe('users admin responsive layout', () => {
  it('kommt ohne horizontalen Tabellen-Scroller aus', async () => {
    const { container } = await render();
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
    expect(container.querySelector('[class*="min-w-[64rem]"]')).toBeNull();
    expect([...container.querySelector('table')!.classList]).toContain('xl:table-fixed');
  });

  it('stapelt Zeilen unterhalb des Desktop-Breakpoints als Karten mit eigenen Feldbeschriftungen', async () => {
    const { container } = await render();
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    for (const tr of rows) {
      expect([...tr.classList]).toEqual(expect.arrayContaining(['sm:grid-cols-2', 'xl:table-row']));
      const labels = [...tr.querySelectorAll(':scope > td > span.xl\\:hidden')].map(
        (span) => span.textContent,
      );
      expect(labels).toEqual(headers.map((header) => header!.trim()));
    }
  });

  it('markiert inaktive Zeilen, ohne den Kontrast aller Inhalte zu senken', async () => {
    await render();
    const inactive = row('Inaktive Person');
    expect([...inactive.classList]).toContain('bg-surface-page');
    expect(inactive.className).not.toContain('opacity-');
    expect([...row('Aktive Person').classList]).toContain('xl:hover:bg-gray-50');
  });

  it('lässt Rollen- und Berechtigungs-Chips innerhalb ihrer Zelle umbrechen', async () => {
    await render();
    const active = row('Aktive Person');
    for (const chip of [
      within(active).getByRole('button', { name: 'PARTNER' }),
      within(active).getByRole('button', { name: STAFF_PERMISSIONS[0]!.short }),
    ]) {
      const chips = chip.parentElement!;
      expect(chips.className).toBe('flex min-w-0 flex-wrap gap-1');
      expect(chips.parentElement!.className).toBe('flex min-w-0 flex-wrap items-center gap-2');
    }
  });

  it('nutzt das breite Layout für die ausdrücklichen Kontosicherheits-Bedienelemente', async () => {
    const { container } = await render();
    expect([...(container.firstElementChild as HTMLElement).classList]).toContain('max-w-[112rem]');
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    expect(headers.at(-1)).toBe('Kontosicherheit');
    const security = row('Aktive Person').lastElementChild as HTMLElement;
    expect(within(security).getByRole('button', { name: 'Passwort setzen' })).toBeTruthy();
    expect(within(security).getByRole('button', { name: '2FA zurücksetzen' })).toBeTruthy();
  });

  it('öffnet die Tätigkeitszuordnung als Dialog außerhalb der beschnittenen Tabellenkarte', async () => {
    const { container } = await render();
    fireEvent.click(
      within(row('Aktive Person')).getByRole('button', { name: 'Tätigkeiten zuordnen' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Tätigkeiten zuordnen' });
    expect(container.querySelector('.card.overflow-hidden')!.contains(dialog)).toBe(false);
    expect(within(dialog).getByRole('checkbox', { name: 'Lohn' })).toBeTruthy();
  });
});
