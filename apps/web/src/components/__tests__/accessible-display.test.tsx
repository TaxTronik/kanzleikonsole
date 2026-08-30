import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccessibleDisplayProvider, AccessibleDisplaySettings } from '../accessible-display';

function render(enabled: boolean) {
  return renderToStaticMarkup(
    <AccessibleDisplayProvider initialEnabled={enabled} saveAction={async () => ({ ok: true })}>
      <AccessibleDisplaySettings />
    </AccessibleDisplayProvider>,
  );
}

describe('persönlicher barrierearmer Anzeigemodus', () => {
  it.each([false, true])('rendert den gespeicherten Zustand %s schon serverseitig', (enabled) => {
    const markup = render(enabled);
    expect(markup).toContain(`data-accessible-display="${enabled}"`);
    expect(markup.match(/<input\b[^>]*>/)?.[0].includes('checked=""')).toBe(enabled);
    expect(markup).toContain('data-accessible-font-size="large"');
    expect(markup).toContain('data-accessible-spacing="relaxed"');
    expect(markup).toContain('data-accessible-contrast="strong"');
    expect(markup).toContain('data-accessible-reduce-motion="true"');
    expect(markup).toContain('Anzeige individuell anpassen');
    expect(markup).toContain('Barrierearmen Anzeigemodus aktivieren');
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('role="status"');
  });

  it('verlangt eine authentifizierte Profilumgebung statt eines browserweiten Fallbacks', () => {
    expect(() => renderToStaticMarkup(<AccessibleDisplaySettings />)).toThrow('profile provider');
    const source = readFileSync(new URL('../accessible-display.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('localStorage.');
    expect(source).not.toContain('document.cookie');
    expect(source).toContain('useOptimistic(initialEnabled)');
    expect(source).toContain('aria-disabled={pending}');
    expect(source).not.toMatch(/\sdisabled=/);
    expect(source).toContain('role="alert"');
  });

  it('isoliert Staff- und Portalzustände bei Profilwechseln und bleibt außerhalb des Logins', () => {
    for (const scope of ['staff', 'portal']) {
      const protectedLayout = readFileSync(
        new URL(`../../app/${scope}/(protected)/layout.tsx`, import.meta.url),
        'utf8',
      );
      const authLayout = readFileSync(
        new URL(`../../app/${scope}/(auth)/layout.tsx`, import.meta.url),
        'utf8',
      );
      expect(protectedLayout).toContain('readAccessibleDisplay(');
      expect(protectedLayout).toContain('initialEnabled={accessibleDisplay}');
      expect(protectedLayout).toContain(`key={\`${scope}:`);
      expect(authLayout).not.toContain('AccessibleDisplayProvider');
    }
  });
});
