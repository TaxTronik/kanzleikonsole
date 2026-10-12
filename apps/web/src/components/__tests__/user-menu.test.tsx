// @vitest-environment jsdom
// Konto-Menü: Profil-Link und Logout als Verhaltenstest (B-08, Welle 15). Der
// Logout läuft über ein Formular außerhalb des sich schließenden
// Dropdown-Portals, damit Radix den Menüeintrag nicht vor dem POST entfernt.
// Die Avatar-Zentrierung prüft app/__tests__/stylesheet-contracts.test.ts.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserMenu } from '../user-menu';

afterEach(() => {
  vi.restoreAllMocks();
});

function openMenu() {
  render(
    <UserMenu
      name="Erika Muster"
      email="erika@kanzlei.example"
      profileHref="/staff/profile"
      profileLabel="Benutzerprofil"
      logoutAction="/api/staff/force-logout"
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Konto-Menü öffnen' });
  expect(trigger.textContent).toContain('EM');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('UserMenu', () => {
  it('zeigt Konto-Kopf und verlinkt das Profil', () => {
    const menu = openMenu();
    expect(menu.textContent).toContain('Erika Muster');
    expect(menu.textContent).toContain('erika@kanzlei.example');
    const profile = screen.getByRole('menuitem', { name: 'Benutzerprofil' });
    expect(profile.getAttribute('href')).toBe('/staff/profile');
  });

  it('sendet den Logout per POST über ein Formular außerhalb des Dropdown-Portals', async () => {
    const submitted: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this);
    });
    const menu = openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Abmelden' }));

    await waitFor(() => expect(submitted).toHaveLength(1));
    const form = submitted[0]!;
    expect(form.getAttribute('action')).toBe('/api/staff/force-logout');
    expect(form.getAttribute('method')).toBe('post');
    expect(menu.contains(form)).toBe(false);
    // Das Menü schließt, das Formular bleibt für den POST gemountet.
    await waitFor(() => expect(menu.isConnected).toBe(false));
    expect(form.isConnected).toBe(true);
  });
});
