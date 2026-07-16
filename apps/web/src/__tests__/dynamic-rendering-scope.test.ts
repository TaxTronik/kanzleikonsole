import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dynamic rendering scope', () => {
  it('is declared once at the root instead of repeated on pages', () => {
    const rootLayout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(rootLayout).toContain("export const dynamic = 'force-dynamic'");

    const pageFiles = globSync('src/app/**/page.tsx');
    const redundant = pageFiles.filter((file) =>
      readFileSync(file, 'utf8').includes("export const dynamic = 'force-dynamic'"),
    );

    expect(redundant).toEqual([]);
  });
});
