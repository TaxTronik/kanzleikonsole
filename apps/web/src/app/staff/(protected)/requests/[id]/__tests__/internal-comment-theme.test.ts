import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

// Fachkatalog: REQ-INTERNAL-COMMENT-001 (nur Darstellung; Kanaltrennung unverändert)
describe('internal request comments theme', () => {
  it('uses semantic high-contrast surfaces in light and dark mode', () => {
    expect(pageSource).toContain('border-l-amber-500 bg-surface-raised');
    expect(pageSource).toContain('divide-y divide-border-subtle');
    expect(pageSource).toContain('className="text-xs text-muted"');
    expect(pageSource).not.toContain('bg-amber-50/30');
  });
});
