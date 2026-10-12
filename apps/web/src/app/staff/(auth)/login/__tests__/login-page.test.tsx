// @vitest-environment jsdom
// Staff-Login als Verhaltenstest (B-08, Welle 15): Kanzlei-neutrale
// Überschrift ohne Produkt-Wortmarke, validiertes returnTo als Formularwert
// des Code-Schritts (der Redirect folgt serverseitig in loginAction, siehe
// login-redirect.test.ts) und der Download der Recovery-Codes. Das
// Kanzlei-Branding des Rahmens prüft components/__tests__/auth-shell.test.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  search: new URLSearchParams(),
  checkPasswordAction: vi.fn(),
  confirmTotpEnrollmentAction: vi.fn(),
  loginAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => m.search }));
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn(),
}));
vi.mock('../actions', () => ({
  beginHardwareLoginAction: vi.fn(),
  checkPasswordAction: m.checkPasswordAction,
  confirmTotpEnrollmentAction: m.confirmTotpEnrollmentAction,
  hardwareLoginAvailabilityAction: vi.fn(async () => ({ available: false })),
  loginAction: m.loginAction,
  loginHardwareAction: vi.fn(),
}));

import StaffLoginPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  m.search = new URLSearchParams();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function passwordStep() {
  render(<StaffLoginPage />);
  fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'erika@kanzlei.example' } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'geheim' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  });
}

describe('Staff-Login', () => {
  it('zeigt „Mitarbeiter-Login" ohne eigene TaxTronik-Wortmarke', () => {
    render(<StaffLoginPage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Mitarbeiter-Login');
    expect(document.body.textContent).not.toMatch(/TaxTronik/i);
  });

  it.each([
    ['/staff/clients?view=list', '/staff/clients?view=list'],
    ['//evil.example/x', '/staff/dashboard'],
    ['/portal/dashboard', '/staff/dashboard'],
  ])(
    'übergibt returnTo %s validiert als Formularwert an loginAction (%s)',
    async (raw, expected) => {
      m.search = new URLSearchParams({ returnTo: raw });
      m.checkPasswordAction.mockResolvedValue({
        ok: true,
        loginTicket: 'ticket-1',
        totpRequired: true,
      });
      m.loginAction.mockResolvedValue({ ok: true });
      const consoleError = vi.spyOn(console, 'error');
      await passwordStep();

      const code = await screen.findByLabelText('TOTP-Code oder Recovery-Code');
      const hidden = code
        .closest('form')!
        .querySelector<HTMLInputElement>('input[type="hidden"][name="returnTo"]')!;
      expect(hidden.value).toBe(expected);

      fireEvent.change(code, { target: { value: '123456' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
      });
      await waitFor(() => expect(m.loginAction).toHaveBeenCalledOnce());
      const data = m.loginAction.mock.calls[0]![0] as FormData;
      expect(data.get('returnTo')).toBe(expected);
      expect(data.get('loginTicket')).toBe('ticket-1');
      expect(data.get('totpCode')).toBe('123456');
      // Keine clientseitige Navigation nach dem Login (jsdom meldet sie als Fehler).
      expect(String(consoleError.mock.calls)).not.toMatch(/navigation/i);
    },
  );

  it('bietet die Recovery-Codes nach der Ersteinrichtung als Textdatei an', async () => {
    m.checkPasswordAction.mockResolvedValue({
      ok: true,
      loginTicket: 'ticket-1',
      totpSetupRequired: true,
      setupSecret: 'SECRET',
      setupQrDataUrl: 'data:image/png;base64,AA',
    });
    m.confirmTotpEnrollmentAction.mockResolvedValue({
      ok: true,
      loginTicket: 'ticket-2',
      backupCodes: ['ABCDEFGH23', 'JKMNPQRS45'],
    });
    await passwordStep();
    fireEvent.click(await screen.findByRole('button', { name: 'QR-Code gescannt — weiter' }));
    fireEvent.change(screen.getByLabelText('Bestätigungs-Code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Bestätigen und anmelden' }));
    });
    await screen.findByText('Recovery-Codes');

    const downloads: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ download: this.download, href: this.href });
    });
    let blob: Blob | undefined;
    const createObjectURL = vi.fn((value: Blob) => {
      blob = value;
      return 'blob:codes';
    });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));

    fireEvent.click(screen.getByRole('button', { name: 'Als Textdatei herunterladen' }));
    expect(downloads).toEqual([
      { download: 'mitarbeiter-login-backup-codes.txt', href: 'blob:codes' },
    ]);
    expect(await blob!.text()).toContain('01. ABCDEFGH23\n02. JKMNPQRS45');
  });
});
