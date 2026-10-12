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
          /\bcreatePortal\b/.test(source) ? 'createPortal' : null,
          /(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(source) ? 'Browserdialog' : null,
        ].filter(Boolean);
        return reasons.map((reason) => `${path}: ${reason}`);
      });

    expect(violations).toEqual([]);
  });
  // Dialogrolle, Fokusführung, Escape und den bestätigten Formular-Submit
  // prüft modal-a11y.test.tsx als Verhalten (B-08, Welle 15).
});
