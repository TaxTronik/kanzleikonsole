// R-14: Portal- und Staff-Login teilen einen AuthShell — gleicher Rahmen,
// Kanzlei-Branding und Pflicht-Footer, kein zweites Layout zum Auseinanderlaufen.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  branding: {
    displayName: 'Kanzlei Muster',
    subtitle: 'Steuerberatung',
    logoDataUrl: null as string | null,
    logoDataUrlDark: null as string | null,
    accentColor: '#1d4ed8',
  },
}));

vi.mock('@/server/settings/legal', () => ({
  readLegalForSlug: vi.fn(async () => ({ imprintUrl: '/impressum', privacyUrl: '/datenschutz' })),
}));
vi.mock('@/server/settings/branding', () => ({
  readBrandingForSlug: vi.fn(async () => h.branding),
}));
vi.mock('@/components/legal-footer', () => ({
  LegalFooter: () => <footer>Impressum · Datenschutz</footer>,
}));

import PortalAuthLayout from '@/app/portal/(auth)/layout';
import StaffAuthLayout from '@/app/staff/(auth)/layout';
import { AuthShell } from '../auth-shell';
import { readBrandingForSlug } from '@/server/settings/branding';

async function render(node: Promise<React.ReactElement> | React.ReactElement): Promise<string> {
  // Async Server Components einmal auflösen, dann statisch rendern.
  const element = await node;
  const resolved =
    typeof element.type === 'function'
      ? await (element.type as (props: unknown) => Promise<React.ReactElement>)(element.props)
      : element;
  return renderToStaticMarkup(resolved);
}

describe('AuthShell', () => {
  it('rendert Branding, Login-Inhalt und Pflicht-Footer', async () => {
    const html = await render(AuthShell({ children: <h1>Login</h1> }));

    expect(html).toContain('Kanzlei Muster');
    expect(html).toContain('Steuerberatung');
    expect(html).toContain('<h1>Login</h1>');
    expect(html).toContain('Impressum · Datenschutz');
    expect(html).toContain('id="main-content"');
    expect(readBrandingForSlug).toHaveBeenCalledWith('default');
  });

  it('wird von Portal- und Staff-Layout identisch verwendet', async () => {
    const portal = await render(PortalAuthLayout({ children: <p>Inhalt</p> }));
    const staff = await render(StaffAuthLayout({ children: <p>Inhalt</p> }));

    expect(portal).toBe(staff);
    expect(portal).toContain('<p>Inhalt</p>');
  });
});
