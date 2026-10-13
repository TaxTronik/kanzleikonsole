// @vitest-environment jsdom
// Fehler- und 404-Seiten (F-16) als Render- und Verhaltenstest (B-08,
// Welle 15): Die frühere Quelltextprüfung (Import von ErrorState, kein
// eigenes onClick, globals.css und ThemeSync in global-error.tsx) ist durch
// Markup-Gleichheit mit ErrorState, den Klick auf „Erneut versuchen" und
// Modul-Mocks ersetzt, die nur beim tatsächlichen Import bzw. Rendern greifen.
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  globalsCss: vi.fn(),
  themeSync: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('../globals.css', () => {
  h.globalsCss();
  return {};
});
vi.mock('@/components/theme-sync', () => ({
  ThemeSync: () => {
    h.themeSync();
    return null;
  },
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import RootError from '../error';
import StaffError from '../staff/(protected)/error';
import PortalError from '../portal/(protected)/error';
import GlobalError from '../global-error';
import RootNotFound from '../not-found';
import StaffNotFound from '../staff/(protected)/not-found';
import PortalNotFound from '../portal/(protected)/not-found';
import { ErrorState } from '@/components/error-state';

const error = Object.assign(new Error('boom'), { digest: 'd1' });

beforeEach(() => {
  h.refresh.mockClear();
  h.themeSync.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Fehler- und 404-Seiten (F-16)', () => {
  it.each([
    ['error.tsx', RootError, 'Etwas ist schiefgelaufen', 'Bitte versuchen Sie es erneut.', 'page'],
    [
      'staff/(protected)/error.tsx',
      StaffError,
      'Seite konnte nicht geladen werden',
      'wenden Sie sich an den Support.',
      'segment',
    ],
    [
      'portal/(protected)/error.tsx',
      PortalError,
      'Seite konnte nicht geladen werden',
      'wenden Sie sich an Ihre Steuerkanzlei.',
      'segment',
    ],
  ] as const)('%s nutzt die gemeinsame ErrorState-Anzeige', (_file, Page, title, hint, layout) => {
    const html = renderToStaticMarkup(<Page error={error} reset={vi.fn()} />);
    expect(html).toContain(title);
    expect(html).toContain(hint);
    expect(html).toContain('Erneut versuchen');
    // Dasselbe Markup wie ErrorState mit Titel und Hinweis: keine eigene Anzeige.
    const contactHint = hint.startsWith('Bitte')
      ? undefined
      : `bleibt das Problem bestehen, ${hint}`;
    expect(html).toBe(
      renderToStaticMarkup(
        <ErrorState
          error={error}
          reset={vi.fn()}
          title={title}
          contactHint={contactHint}
          layout={layout}
        />,
      ),
    );
  });

  it.each([
    ['error.tsx', RootError],
    ['staff/(protected)/error.tsx', StaffError],
    ['portal/(protected)/error.tsx', PortalError],
    ['global-error.tsx', GlobalError],
  ] as const)(
    '%s lädt mit „Erneut versuchen" Serverdaten neu und setzt die Grenze zurück',
    (_file, Page) => {
      const reset = vi.fn();
      // global-error.tsx rendert ein eigenes <html>; React 19 bindet es an das
      // vorhandene Dokument (die Verschachtelungswarnung fängt der console-Spy).
      render(<Page error={error} reset={reset} />);
      const buttons = screen.getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual(['Erneut versuchen']);
      fireEvent.click(buttons[0]!);
      expect(h.refresh).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenCalledOnce();
    },
  );

  it('global-error.tsx rendert ein eigenes deutsches Dokument mit Styles und Theme', () => {
    const html = renderToStaticMarkup(<GlobalError error={error} reset={vi.fn()} />);
    // React hebt <title> in den <head> des eigenen Dokuments.
    expect(html).toMatch(/^<html lang="de"><head><title>Fehler · TaxTronik<\/title><\/head><body>/);
    expect(html).toContain('Die Anwendung konnte nicht geladen werden');
    expect(html).toContain('Fehler-Code: d1');
    // Die Mocks greifen nur, wenn global-error.tsx die Styles importiert und
    // ThemeSync tatsächlich rendert.
    expect(h.globalsCss).toHaveBeenCalled();
    expect(h.themeSync).toHaveBeenCalledOnce();
  });

  it.each([
    ['not-found.tsx', RootNotFound, ['/staff/dashboard', '/portal/dashboard']],
    ['staff/(protected)/not-found.tsx', StaffNotFound, ['/staff/dashboard']],
    ['portal/(protected)/not-found.tsx', PortalNotFound, ['/portal/dashboard']],
  ] as const)(
    '%s zeigt eine deutsche 404-Seite statt der Next-Standardseite',
    (_file, Page, hrefs) => {
      const html = renderToStaticMarkup(<Page />);
      expect(html).toContain(
        '<h1 class="text-lg font-semibold text-primary mb-2">Seite nicht gefunden</h1>',
      );
      expect(html).toContain('existiert nicht (mehr) oder ist für Ihr Konto nicht');
      expect(html).not.toMatch(/could not be found|404/i);
      expect([...html.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1])).toEqual(hrefs);
    },
  );
});
