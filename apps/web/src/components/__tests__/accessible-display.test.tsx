// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccessibleDisplayProvider, AccessibleDisplaySettings } from '../accessible-display';

function markup(enabled: boolean) {
  return renderToStaticMarkup(
    <AccessibleDisplayProvider initialEnabled={enabled} saveAction={async () => ({ ok: true })}>
      <AccessibleDisplaySettings />
    </AccessibleDisplayProvider>,
  );
}

describe('persönlicher barrierearmer Anzeigemodus', () => {
  it.each([false, true])('rendert den gespeicherten Zustand %s schon serverseitig', (enabled) => {
    const html = markup(enabled);
    expect(html).toContain(`data-accessible-display="${enabled}"`);
    expect(html.match(/<input\b[^>]*>/)?.[0].includes('checked=""')).toBe(enabled);
    expect(html).toContain('data-accessible-font-size="large"');
    expect(html).toContain('data-accessible-spacing="relaxed"');
    expect(html).toContain('data-accessible-contrast="strong"');
    expect(html).toContain('data-accessible-reduce-motion="true"');
    expect(html).toContain('Anzeige individuell anpassen');
    expect(html).toContain('Barrierearmen Anzeigemodus aktivieren');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('role="status"');
  });

  it('verlangt eine authentifizierte Profilumgebung statt eines browserweiten Fallbacks', () => {
    expect(() => renderToStaticMarkup(<AccessibleDisplaySettings />)).toThrow('profile provider');
  });

  // Verhalten statt Quelltext (B-08): optimistisch umschalten, während des
  // Speicherns bedienbar bleiben (aria-disabled statt disabled), bei Fehler
  // zurückfallen und melden; gespeichert wird nur über die Profil-Action.
  // Profilbindung (key je Staff-/Portalprofil, Wert aus der Layout-Transaktion)
  // und Login ohne Provider prüft app/__tests__/protected-layouts.test.tsx.
  type Save = (enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;

  function renderSettings(saveAction: Save) {
    render(
      <AccessibleDisplayProvider initialEnabled={false} saveAction={saveAction}>
        <AccessibleDisplaySettings />
      </AccessibleDisplayProvider>,
    );
    return screen.getByRole('checkbox', {
      name: 'Barrierearmen Anzeigemodus aktivieren',
    }) as HTMLInputElement;
  }

  function marker() {
    return document
      .querySelector('[data-accessible-display]')!
      .getAttribute('data-accessible-display');
  }

  it('schaltet sofort optimistisch um und bleibt während des Speicherns fokussierbar', async () => {
    let finish!: (result: { ok: true }) => void;
    const saveAction = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    const checkbox = renderSettings(saveAction);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookieBefore = document.cookie;

    fireEvent.click(checkbox);
    await waitFor(() => expect(marker()).toBe('true'));
    expect(checkbox.checked).toBe(true);
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    expect(checkbox.disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('Anzeigeeinstellung wird gespeichert …');
    expect(saveAction).toHaveBeenCalledWith(true);

    await act(async () => finish({ ok: true }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Anzeigeeinstellung gespeichert.'),
    );
    expect(checkbox.getAttribute('aria-disabled')).toBe('false');
    // Kein browserweiter Zustand: weder localStorage noch Cookie.
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookieBefore);
    setItem.mockRestore();
  });

  it('fällt bei einem Speicherfehler auf den Serverstand zurück und meldet ihn als Alert', async () => {
    const checkbox = renderSettings(async () => ({
      ok: false,
      error: 'Speichern fehlgeschlagen.',
    }));
    fireEvent.click(checkbox);
    expect((await screen.findByRole('alert')).textContent).toBe('Speichern fehlgeschlagen.');
    await waitFor(() => expect(marker()).toBe('false'));
    expect(checkbox.checked).toBe(false);
  });
});
