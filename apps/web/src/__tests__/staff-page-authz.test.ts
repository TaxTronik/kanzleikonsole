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

/** Tax-CMS-Seitenhelfer aus server/tcms/seite.ts und ihr zentraler Guard. */
const TCMS_HELFER = ['tcmsMandantSeite', 'tcmsKanzleiSeite', 'tcmsAdminSeite'] as const;
const TCMS_SEITE = join(PROTECTED_DIR, '..', '..', '..', 'server', 'tcms', 'seite.ts');

/** Rumpf einer exportierten Konstante `name = cache(async function …)` bis zur nächsten. */
function helferRumpf(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = `);
  if (start < 0) return '';
  const ende = source.indexOf('\nexport ', start + 1);
  return source.slice(start, ende < 0 ? undefined : ende);
}

describe('staff page authorization guardrail', () => {
  it('keeps the protected page surface on centralized guards', () => {
    expect(pages.length).toBeGreaterThan(80);

    const violations = pages.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const relativePath = relative(PROTECTED_DIR, path).replaceAll('\\', '/');
      // requireClientPageAccess und guardSubsumtionPage rufen requireStaffPage
      // selbst (client-page-authz.test.ts prüft die Mandanten-Seiten im Detail),
      // ebenso die Tax-CMS-Seitenhelfer (Test unten, TCMS Stufe 3).
      const usesCentralGuard =
        source.includes('requireStaffPage(') ||
        source.includes('requireClientPageAccess(') ||
        source.includes('guardSubsumtionPage(') ||
        TCMS_HELFER.some((helfer) => source.includes(`${helfer}(`));

      return usesCentralGuard && !source.includes('staffAuth(') ? [] : [relativePath];
    });

    expect(violations).toEqual([]);
  });

  it('lets the Tax-CMS page helpers start with the central guards', () => {
    const source = readFileSync(TCMS_SEITE, 'utf8');
    expect(helferRumpf(source, 'tcmsMandantSeite')).toMatch(
      /^[^]*?\{\s*const session = await requireClientPageAccess\(clientId\);/,
    );
    expect(helferRumpf(source, 'tcmsKanzleiSeite')).toContain(
      'const session = await requireStaffPage();',
    );
    expect(helferRumpf(source, 'tcmsAdminSeite')).toContain(
      'const session = await requireStaffPage({ admin: true',
    );
    for (const helfer of TCMS_HELFER) {
      expect(helferRumpf(source, helfer), helfer).not.toContain('staffAuth(');
    }
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
