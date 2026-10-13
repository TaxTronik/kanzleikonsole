// @vitest-environment jsdom
// Benutzerprofil als Render- und Verhaltenstest (B-08, Welle 15) statt
// Quelltextprüfung. Den Profil-Link im Konto-Menü neben dem Abmelden prüft
// app/__tests__/protected-layouts.test.tsx.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({ changePassword: vi.fn(), account: null as unknown }));

vi.mock('../actions', () => ({ changeOwnPasswordAction: h.changePassword }));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['EMPLOYEE'], name: 'Erika' },
  })),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ staffUser: { findUnique: vi.fn(async () => h.account) } }),
  ),
}));
vi.mock('@/server/auth/webauthn', () => ({ isHardwareAccessConfigured: () => false }));
vi.mock('../hardware-key-settings', () => ({ HardwareKeySettings: () => null }));
vi.mock('@/components/accessible-display', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/accessible-display')>()),
  AccessibleDisplaySettings: () => null,
}));

import StaffProfilePage from '../page';
import { ChangePasswordForm } from '../password-form';

function account(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Erika Muster',
    email: 'erika@kanzlei.example',
    datevAdvisorNumber: null,
    totpEnrolledAt: new Date('2026-01-01T00:00:00.000Z'),
    hardwareOnlyEnabledAt: null,
    hardwareCredentials: [],
    ...overrides,
  };
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  h.account = account();
  assign = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('staff user profile UI', () => {
  it('erfasst aktuelles, neues und bestätigtes Passwort verdeckt', () => {
    const { container } = render(<ChangePasswordForm />);
    const passwords = [...container.querySelectorAll('input')];
    expect(passwords.map((input) => [input.name, input.type])).toEqual([
      ['currentPassword', 'password'],
      ['newPassword', 'password'],
      ['confirmPassword', 'password'],
    ]);
  });

  it('meldet nach erfolgreicher Änderung überall ab', async () => {
    h.changePassword.mockResolvedValueOnce({ ok: true });
    const { container } = render(<ChangePasswordForm />);
    for (const [label, value] of [
      ['Aktuelles Passwort', 'alt-geheim-123'],
      ['Neues Passwort', 'neu-geheim-12345'],
      ['Neues Passwort wiederholen', 'neu-geheim-12345'],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    expect(h.changePassword).toHaveBeenCalledOnce();
    expect(screen.getByText('Passwort geändert. Sie werden abgemeldet…')).toBeTruthy();
    expect(assign).toHaveBeenCalledExactlyOnceWith('/api/staff/force-logout');
    // Die eingegebenen Passwörter bleiben nicht im Formular stehen.
    expect([...container.querySelectorAll('input')].map((input) => input.value)).toEqual([
      '',
      '',
      '',
    ]);
  });

  it('bleibt bei einer Ablehnung angemeldet und zeigt den Fehler', async () => {
    h.changePassword.mockResolvedValueOnce({ ok: false, error: 'Aktuelles Passwort falsch.' });
    const { container } = render(<ChangePasswordForm />);
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });
    expect(screen.getByText('Aktuelles Passwort falsch.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('zeigt den aktuellen 2FA-Stand und den Wiederherstellungsweg', async () => {
    await renderServer(StaffProfilePage());
    expect(screen.getByRole('heading', { name: 'Zwei-Faktor-Authentisierung' })).toBeTruthy();
    expect(screen.getByText('2FA ist für dieses Konto aktiv.')).toBeTruthy();
    expect(screen.getByText(/kann ein Admin die 2FA-Zuordnung/)).toBeTruthy();
  });

  it('zeigt eine offene 2FA-Einrichtung an', async () => {
    h.account = account({ totpEnrolledAt: null });
    await renderServer(StaffProfilePage());
    expect(screen.getByText('2FA wird bei der nächsten Anmeldung eingerichtet.')).toBeTruthy();
  });
});
