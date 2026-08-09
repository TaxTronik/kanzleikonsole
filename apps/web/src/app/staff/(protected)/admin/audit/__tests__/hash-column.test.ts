import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

describe('audit hash column', () => {
  it('shows the complete audit hash and keeps it wrappable', () => {
    expect(pageSource).toContain("Buffer.from(e.thisHash).toString('hex')");
    expect(pageSource).not.toContain("toString('hex').slice(0, 12)");
    expect(pageSource).toContain('text-disabled font-mono break-all');
  });
});
