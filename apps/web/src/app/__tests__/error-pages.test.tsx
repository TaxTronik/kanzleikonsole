import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
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

const APP_DIR = resolve(__dirname, '..');
const error = Object.assign(new Error('boom'), { digest: 'd1' });

describe('Fehler- und 404-Seiten (F-16)', () => {
  it.each([
    ['error.tsx', RootError, 'Etwas ist schiefgelaufen', 'Bitte versuchen Sie es erneut.'],
    [
      'staff/(protected)/error.tsx',
      StaffError,
      'Seite konnte nicht geladen werden',
      'wenden Sie sich an den Support.',
    ],
    [
      'portal/(protected)/error.tsx',
      PortalError,
      'Seite konnte nicht geladen werden',
      'wenden Sie sich an Ihre Steuerkanzlei.',
    ],
  ] as const)('%s nutzt die gemeinsame ErrorState-Anzeige', (file, Page, title, hint) => {
    const html = renderToStaticMarkup(<Page error={error} reset={vi.fn()} />);
    expect(html).toContain(title);
    expect(html).toContain(hint);
    expect(html).toContain('Erneut versuchen');
    const source = readFileSync(join(APP_DIR, file), 'utf8');
    expect(source).toContain("from '@/components/error-state'");
    expect(source).not.toContain('onClick');
  });

  it('global-error.tsx rendert ein eigenes deutsches Dokument mit Styles und Theme', () => {
    const html = renderToStaticMarkup(<GlobalError error={error} reset={vi.fn()} />);
    // React hebt <title> in den <head> des eigenen Dokuments.
    expect(html).toMatch(/^<html lang="de"><head><title>Fehler · TaxTronik<\/title><\/head><body>/);
    expect(html).toContain('Die Anwendung konnte nicht geladen werden');
    expect(html).toContain('Fehler-Code: d1');
    const source = readFileSync(join(APP_DIR, 'global-error.tsx'), 'utf8');
    expect(source).toContain("import './globals.css';");
    expect(source).toContain('<ThemeSync />');
  });

  it.each([
    ['not-found.tsx', RootNotFound, ['/staff/dashboard', '/portal/dashboard']],
    ['staff/(protected)/not-found.tsx', StaffNotFound, ['/staff/dashboard']],
    ['portal/(protected)/not-found.tsx', PortalNotFound, ['/portal/dashboard']],
  ] as const)(
    '%s zeigt eine deutsche 404-Seite statt der Next-Standardseite',
    (file, Page, hrefs) => {
      expect(existsSync(join(APP_DIR, file))).toBe(true);
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
