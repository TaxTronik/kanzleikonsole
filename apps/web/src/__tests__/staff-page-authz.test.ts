import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROTECTED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'app',
  'staff',
  '(protected)',
);

function walkPages(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walkPages(path));
    else if (entry === 'page.tsx') files.push(path);
  }
  return files;
}

const pages = walkPages(PROTECTED_DIR);

describe('staff page authorization guardrail', () => {
  it('keeps the protected page surface on centralized guards', () => {
    expect(pages.length).toBeGreaterThan(80);

    const violations = pages.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const relativePath = relative(PROTECTED_DIR, path).replaceAll('\\', '/');
      const usesCentralGuard =
        source.includes('requireStaffPage(') || source.includes('guardSubsumtionPage(');

      return usesCentralGuard && !source.includes('staffAuth(') ? [] : [relativePath];
    });

    expect(violations).toEqual([]);
  });

  it('keeps admin pages on the explicit admin guard', () => {
    const violations = pages
      .filter((path) => relative(PROTECTED_DIR, path).replaceAll('\\', '/').startsWith('admin/'))
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return source.includes('requireStaffPage({ admin: true')
          ? []
          : [relative(PROTECTED_DIR, path).replaceAll('\\', '/')];
      });

    expect(violations).toEqual([]);
  });
});
