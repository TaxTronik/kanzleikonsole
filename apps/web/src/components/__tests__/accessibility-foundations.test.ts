import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = resolve(componentsDir, '..', 'app');

function source(path: string) {
  return readFileSync(path, 'utf8');
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe('globale Accessibility-Grundlagen', () => {
  it('macht die mobile Navigation zu einem fokussierten, isolierten Dialog', () => {
    const mobileSidebar = source(resolve(componentsDir, 'mobile-sidebar-toggle.tsx'));

    expect(mobileSidebar).toContain('aria-controls="app-sidebar"');
    expect(mobileSidebar).toContain('aria-expanded={isMobile && open}');
    expect(mobileSidebar).toContain("sidebar.setAttribute('inert', '')");
    expect(mobileSidebar).toContain("main?.setAttribute('inert', '')");
    expect(mobileSidebar).toContain("sidebar.setAttribute('aria-modal', 'true')");
    expect(mobileSidebar).toContain("if (event.key === 'Escape')");
    expect(mobileSidebar).toContain('closeRef.current?.focus()');
    expect(mobileSidebar).toContain('triggerRef.current?.focus()');
  });

  it('stellt Skip-Link, Sidebar-Ziel und fokussierbares Main in beiden Apps bereit', () => {
    for (const path of [
      resolve(appDir, 'staff', '(protected)', 'layout.tsx'),
      resolve(appDir, 'portal', '(protected)', 'layout.tsx'),
    ]) {
      const layout = source(path);
      expect(layout).toContain('href="#main-content"');
      expect(layout).toContain('className="skip-link"');
      expect(layout).toContain('id="app-sidebar"');
      expect(layout).toContain('aria-label="Hauptmenü"');
      expect(layout).toContain('id="main-content" tabIndex={-1}');
    }
  });

  it('nutzt auch auf den Login-Seiten ein Main-Landmark', () => {
    for (const path of [
      resolve(appDir, 'staff', '(auth)', 'layout.tsx'),
      resolve(appDir, 'portal', '(auth)', 'layout.tsx'),
    ]) {
      const layout = source(path);
      expect(layout).toContain('<main');
      expect(layout).toContain('id="main-content"');
      expect(layout).toContain('tabIndex={-1}');
    }
  });

  it('bildet die globale Suche als Combobox mit Listbox und Live-Status ab', () => {
    const globalSearch = source(resolve(componentsDir, 'global-search.tsx'));

    expect(globalSearch).toContain('role="combobox"');
    expect(globalSearch).toContain('aria-autocomplete="list"');
    expect(globalSearch).toContain('aria-activedescendant={activeOptionId}');
    expect(globalSearch).toContain('role="listbox"');
    expect(globalSearch).toContain('role="option"');
    expect(globalSearch).toContain('aria-selected={i === activeIdx}');
    expect(globalSearch).toContain('role="status"');
    expect(globalSearch).toContain('aria-live="polite"');
  });

  it('benennt Dialoge, isoliert den Hintergrund und beschriftet Eingaben', () => {
    const modal = source(resolve(componentsDir, 'ui', 'modal.tsx'));

    expect(modal).toContain('aria-labelledby={titleId}');
    expect(modal).toContain('tabIndex={-1}');
    expect(modal).toContain("element.setAttribute('inert', '')");
    expect(modal).toContain('(auto ?? focusables()[0] ?? node).focus()');
    expect(modal).toContain('<label htmlFor={inputId}');
    expect(modal).toContain('aria-invalid={err');
    expect(modal).toContain('role="alert"');
  });

  it('hält Fokus und Sekundärtext auch im Kontrastmodus wahrnehmbar', () => {
    const css = source(resolve(appDir, 'globals.css'));

    expect(css).toContain('--text-muted: 108 101 96');
    expect(css).toContain('--text-disabled: 108 101 96');
    expect(css).toContain('--text-disabled: 145 141 155');
    expect(contrastRatio([108, 101, 96], [233, 231, 226])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio([145, 141, 155], [40, 37, 44])).toBeGreaterThanOrEqual(4.5);
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('outline: 2px solid Highlight !important');
    expect(css).not.toContain('bg-brand-600 text-white');
    expect(css).not.toContain('hover:bg-brand-700');
    expect(css).not.toContain('focus-visible:ring-brand-500');
    expect(css).toMatch(/\.btn-primary:focus-visible[\s\S]*?box-shadow: 0 0 0 3px var\(--ring\);/);
    expect(css).toMatch(/\.btn-primary\s*\{[\s\S]*?color: rgb\(var\(--text-on-brand\)\);/);
    expect(css).toMatch(/\.settings-pill-save\s*\{[\s\S]*?color: rgb\(var\(--text-on-brand\)\);/);
    expect(css).toMatch(/\.modal-close\s*\{[\s\S]*?width: 32px;[\s\S]*?height: 32px;/);
  });
});
