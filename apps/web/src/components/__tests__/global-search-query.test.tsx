import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  query: 'neu',
  previousQuery: 'alt',
  results: [
    {
      type: 'client',
      id: 'old-result',
      title: 'Treffer des vorherigen Suchbegriffs',
      href: '/staff/clients/old-result',
    },
  ],
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    // Start the real render at an input edit with an earlier API result.
    // React itself performs the component's render-phase state updates.
    useState: <T,>(initial: T | (() => T)) => {
      let seeded = initial;
      if (initial === '') seeded = fixture.query as T;
      else if (initial === fixture.query) seeded = fixture.previousQuery as T;
      else if (Array.isArray(initial)) seeded = fixture.results as T;
      else if (initial === false) seeded = true as T; // Search has focus.
      return react.useState(seeded);
    },
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/staff/clients',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../accessible-display', () => ({ useAccessibleDisplayEnabled: () => false }));
vi.mock('../ui/use-anchored-panel', () => ({ useAnchoredPanel: () => ({}) }));

import { GlobalSearch } from '../global-search';

beforeEach(() => {
  fixture.query = 'neu';
  fixture.previousQuery = 'alt';
});

describe('Globale Suche beim Wechsel des Suchbegriffs', () => {
  it.each(['neu', 'anderer Begriff', 'n'])(
    'entfernt alte Datensatztreffer sofort für %s',
    (query) => {
      fixture.query = query;
      const html = renderToStaticMarkup(<GlobalSearch />);
      expect(html).toContain(`value="${query}"`);
      expect(html).not.toContain(fixture.results[0]!.title);
      expect(html).not.toContain('role="option"');
      expect(html).not.toContain('aria-activedescendant=');
    },
  );

  it('lässt unmittelbar passende Navigationsbefehle während der neuen Suche verfügbar', () => {
    const html = renderToStaticMarkup(
      <GlobalSearch navItems={[{ label: 'Neue Anforderungen', href: '/staff/requests' }]} />,
    );
    expect(html).toContain('Neue Anforderungen');
    expect(html).toContain('role="option"');
    expect(html).not.toContain(fixture.results[0]!.title);
  });

  it('behält bestätigte Treffer bei unverändertem Suchbegriff', () => {
    fixture.previousQuery = fixture.query;
    const html = renderToStaticMarkup(<GlobalSearch />);
    expect(html).toContain(fixture.results[0]!.title);
    expect(html).toContain('role="option"');
  });
});
