// Root-Layout: das Theme-Bootstrap-Script trägt die CSP-Nonce der Anfrage und
// unterdrückt die Hydration-Warnung, weil Browser die Nonce aus dem DOM
// entfernen (Render-Test statt Quelltextprüfung, B-08, Welle 15).
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ nonce: 'nonce-123' as string | null }));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(h.nonce ? { 'x-nonce': h.nonce } : {}),
}));
vi.mock('@/components/theme-sync', () => ({ ThemeSync: () => null }));

import { THEME_BOOTSTRAP_JS } from '@/lib/theme';
import RootLayout from '../layout';

type Props = { children?: ReactNode; [key: string]: unknown };

function findScript(node: ReactNode): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findScript(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Props>(node)) return undefined;
  if (node.type === 'script') return node;
  return findScript(node.props.children);
}

describe('Root-Layout', () => {
  it('setzt die Nonce der Anfrage am Theme-Script und unterdrückt deren Hydration-Abgleich', async () => {
    h.nonce = 'nonce-123';
    const tree = await RootLayout({ children: <main>Inhalt</main> });
    const script = findScript(tree);
    expect(script?.props.nonce).toBe('nonce-123');
    expect(script?.props.suppressHydrationWarning).toBe(true);
    expect(script?.props.dangerouslySetInnerHTML).toEqual({ __html: THEME_BOOTSTRAP_JS });

    const html = renderToStaticMarkup(tree);
    expect(html).toMatch(/^<html lang="de"><head><script nonce="nonce-123">/);
    expect(html).toContain('<main>Inhalt</main>');
  });

  it('rendert ohne Nonce-Header kein leeres nonce-Attribut', async () => {
    h.nonce = null;
    const html = renderToStaticMarkup(await RootLayout({ children: null }));
    expect(html).toContain('<head><script>');
  });
});
