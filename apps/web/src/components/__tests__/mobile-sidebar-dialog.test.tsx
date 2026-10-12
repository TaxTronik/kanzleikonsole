// @vitest-environment jsdom
// Mobile Navigation als fokussierter, isolierter Dialog (globale
// Accessibility-Grundlagen) — Verhaltenstest in jsdom statt Quelltextprüfung
// (B-08, Welle 15). Die Fokus-Wiederholung bei verzögerter Sichtbarkeit prüft
// mobile-sidebar-focus.test.ts.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/staff/dashboard' }));

import { MobileSidebarToggle } from '../mobile-sidebar-toggle';

let mobile = true;

beforeEach(() => {
  mobile = true;
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // Layout-Gerüst wie in den geschützten Layouts: Sidebar und Main.
  document.body.innerHTML =
    '<aside id="app-sidebar" aria-label="Hauptmenü"><a href="/staff/clients">Mandanten</a></aside>' +
    '<main id="main-content" tabindex="-1"></main>';
});

afterEach(() => {
  // Das Gerüst ersetzt beforeEach; Testing Library baut die Portale danach ab.
  vi.unstubAllGlobals();
});

function setup() {
  const host = document.createElement('div');
  document.body.append(host);
  render(<MobileSidebarToggle />, { container: host });
  return {
    sidebar: document.getElementById('app-sidebar')!,
    main: document.getElementById('main-content')!,
    trigger: screen.getByRole('button', { name: 'Menü öffnen' }),
  };
}

describe('mobile Navigation', () => {
  it('steuert die Sidebar und hält sie geschlossen aus dem Bedienbaum', () => {
    const { sidebar, trigger } = setup();
    expect(trigger.getAttribute('aria-controls')).toBe('app-sidebar');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(true);
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
  });

  it('öffnet als modaler Dialog, isoliert den Hauptinhalt und fokussiert „Schließen"', async () => {
    const { sidebar, main, trigger } = setup();
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(sidebar.getAttribute('role')).toBe('dialog');
    expect(sidebar.getAttribute('aria-modal')).toBe('true');
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(main.hasAttribute('inert')).toBe(true);
    const close = sidebar.querySelector<HTMLButtonElement>('button[aria-label="Menü schließen"]');
    expect(close).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('schließt mit Escape und gibt den Fokus an den Auslöser zurück', async () => {
    const { sidebar, main, trigger } = setup();
    fireEvent.click(trigger);
    await waitFor(() => expect(sidebar.getAttribute('aria-modal')).toBe('true'));

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.hasAttribute('aria-modal')).toBe(false);
    expect(main.hasAttribute('inert')).toBe(false);
    expect(sidebar.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('meldet auf dem Desktop keinen geöffneten Dialog', () => {
    mobile = false;
    const { sidebar, main, trigger } = setup();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(sidebar.hasAttribute('inert')).toBe(false);
    expect(sidebar.hasAttribute('aria-modal')).toBe(false);
    expect(main.hasAttribute('inert')).toBe(false);
  });
});
