import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const modalPath = resolve(srcRoot, 'components/ui/modal.tsx');

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return productionSources(path);
    }
    return ['.ts', '.tsx'].includes(extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe('gemeinsame Dialog-Infrastruktur', () => {
  it('bündelt Portals und ersetzt native Browserdialoge in Produktionscode', () => {
    const violations = productionSources(srcRoot)
      .filter((path) => path !== modalPath)
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        const reasons = [
          source.includes('createPortal') ? 'createPortal' : null,
          /(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(source) ? 'Browserdialog' : null,
        ].filter(Boolean);
        return reasons.map((reason) => `${path}: ${reason}`);
      });

    expect(violations).toEqual([]);
  });

  it('behält Fokusführung, Dialogrollen und den bestätigten Formular-Submit zentral', () => {
    const source = readFileSync(modalPath, 'utf8');

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("if (e.key === 'Escape')");
    expect(source).toContain("if (e.key !== 'Tab') return");
    expect(source).toContain('prevFocus?.focus?.()');
    expect(source).toContain('export function confirmFormSubmission');
    expect(source).toContain('form.requestSubmit(submitter)');
  });
});
