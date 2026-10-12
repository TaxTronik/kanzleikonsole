// @vitest-environment jsdom
// Globale Suche: Combobox-Semantik, Tastatur, Popup-Platzierung und Reset bei
// Seitenwechsel als Verhaltenstests in jsdom (B-08, Welle 15). Ersetzt die
// Quelltextprüfungen aus global-search-a11y, accessibility-foundations und
// login-navigation-and-autofill.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/staff/dashboard',
  push: vi.fn(),
  anchoredPanel: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('../ui/use-anchored-panel', () => ({
  useAnchoredPanel: (...args: unknown[]) => {
    mocks.anchoredPanel(...args);
    return { left: 4, top: 40, width: 448, maxHeight: 384 };
  },
}));
vi.mock('../ui/anchored-panel', () => ({ revealPanelOption: mocks.reveal }));

import { AccessibleDisplayProvider } from '../accessible-display';
import { GlobalSearch } from '../global-search';

const NAV = [
  { label: 'Mandanten', href: '/staff/clients' },
  { label: 'Mandanten-Onboarding', href: '/staff/clients/onboarding' },
];
const RESULTS = [
  {
    type: 'client',
    id: 'c1',
    title: 'Muster GmbH',
    subtitle: 'Mandant',
    href: '/staff/clients/c1',
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = '/staff/dashboard';
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ results: RESULTS }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(accessibleDisplay = false) {
  const view = render(
    <AccessibleDisplayProvider
      initialEnabled={accessibleDisplay}
      saveAction={async () => ({ ok: true })}
    >
      <GlobalSearch navItems={NAV} />
    </AccessibleDisplayProvider>,
  );
  const input = screen.getByRole('combobox', { name: 'Globale Suche' }) as HTMLInputElement;
  return { ...view, input };
}

async function typeQuery(input: HTMLInputElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  // Debounce 200 ms, dann API-Treffer.
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(NAV.length + 1));
}

describe('globale Suche als Combobox', () => {
  it('meldet Liste, aktive Option und Trefferzahl über Combobox, Listbox und Live-Status', async () => {
    const { input } = setup();
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    await typeQuery(input, 'Ma');
    const listbox = screen.getByRole('listbox', { name: 'Suchergebnisse' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    const options = within(listbox).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(status.textContent).toBe('3 Treffer verfügbar.');
    expect(fetchMock).toHaveBeenCalledWith('/api/staff/search?q=Ma');
  });

  it('zeigt die aktive Option nach Tastaturnavigation im eigenen Panel (ohne scrollIntoView)', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { input } = setup();
    await typeQuery(input, 'Ma');
    mocks.reveal.mockClear();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    expect(mocks.reveal).toHaveBeenLastCalledWith(screen.getByRole('listbox'), options[1]);

    fireEvent.keyDown(input, { key: 'End' });
    expect(mocks.reveal).toHaveBeenLastCalledWith(screen.getByRole('listbox'), options[2]);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('lässt Home, End und Enter bei geschlossener Trefferliste dem Textfeld', () => {
    const { input } = setup();
    fireEvent.focus(input);
    // Ohne Suchbegriff gibt es keine Liste: kein preventDefault, keine Navigation.
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('übernimmt Home, End und Enter bei offener Trefferliste', async () => {
    const { input } = setup();
    await typeQuery(input, 'Ma');
    const options = screen.getAllByRole('option');

    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    expect(fireEvent.keyDown(input, { key: 'Home' })).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(mocks.push).toHaveBeenCalledWith('/staff/clients');
  });

  it('schließt bei Tab und Blur, ohne die native Fokusnavigation zu verhindern', async () => {
    const { input } = setup();
    await typeQuery(input, 'Ma');
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hält den Fokus beim Klick auf eine Option im Eingabefeld', async () => {
    const { input } = setup();
    await typeQuery(input, 'Ma');
    const option = screen.getAllByRole('option')[2]!;
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(mocks.push).toHaveBeenCalledWith('/staff/clients/c1');
  });

  it('passt das Popup an den Viewport an', async () => {
    const { input } = setup();
    await typeQuery(input, 'Ma');
    expect(mocks.anchoredPanel).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ current: expect.any(HTMLDivElement) }),
      448,
      'start',
      384,
    );
    const listbox = screen.getByRole('listbox');
    expect(listbox.style.maxHeight).toBe('384px');
    expect(listbox.style.width).toBe('448px');
  });

  it.each([
    [false, 'item-title', 'text-xs text-muted truncate'],
    [true, 'font-medium break-words', 'text-sm text-muted break-words'],
  ])(
    'zeigt Titel und Untertitel im Anzeigemodus %s vollständig bzw. gekürzt',
    async (accessibleDisplay, titleClass, subtitleClass) => {
      const { input } = setup(accessibleDisplay);
      await typeQuery(input, 'Ma');
      expect(screen.getByText('Muster GmbH').className).toBe(titleClass);
      expect(screen.getByText('Mandant').className).toBe(subtitleClass);
    },
  );
});

describe('globale Suche und Autofill', () => {
  it('ist für Passwortmanager als Suchfeld ohne Autofill gekennzeichnet', () => {
    const { input } = setup();
    expect(input.name).toBe('taxtronik-global-search');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });

  it('setzt die persistente Suche bei Seitenwechsel zurück', async () => {
    const { input, rerender } = setup();
    await typeQuery(input, 'Ma');
    expect(input.value).toBe('Ma');

    mocks.pathname = '/staff/clients';
    await act(async () => {
      rerender(
        <AccessibleDisplayProvider initialEnabled={false} saveAction={async () => ({ ok: true })}>
          <GlobalSearch navItems={NAV} />
        </AccessibleDisplayProvider>,
      );
    });
    const fresh = screen.getByRole('combobox', { name: 'Globale Suche' }) as HTMLInputElement;
    expect(fresh.value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
