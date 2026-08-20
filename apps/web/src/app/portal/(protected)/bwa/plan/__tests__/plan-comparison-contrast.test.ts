import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const comparison = readFileSync(new URL('../plan-comparison.tsx', import.meta.url), 'utf8');

describe('BWA-Planungsvergleich im Dark Mode', () => {
  it('verwendet kontrastreiche semantische Farben für Kopfzeile, Metadaten und Aktion', () => {
    expect(comparison).toContain('bg-surface-raised text-xs font-medium text-secondary');
    expect(comparison).toContain('text-brand-700 hover:underline dark:text-brand-300');
    expect(comparison).toContain('text-xs text-secondary font-normal');
    expect(comparison).toContain('<p className="text-xs text-secondary">');
  });
});
