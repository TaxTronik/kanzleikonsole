import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const autoRefresh = readFileSync(
  new URL('../audit-verify-auto-refresh.tsx', import.meta.url),
  'utf8',
);
const page = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

describe('Audit-Chain-Verifikation', () => {
  it('navigiert nach dem Worker-Ergebnis aus dem Queue-Zustand heraus', () => {
    expect(autoRefresh).toContain("router.replace('/staff/admin/audit', { scroll: false })");
    expect(autoRefresh).not.toContain('router.refresh()');
  });

  it('zeigt den Wartetext nur während des Pollings und mit Dark-Mode-Kontrast', () => {
    expect(page).toContain('{pollVerify && (');
    expect(page).toContain('text-xs text-primary mt-2');
    expect(page).toContain('dark:bg-green-950/50');
    expect(page).toContain('dark:text-green-100');
    expect(autoRefresh).toContain('dark:bg-yellow-950/50');
  });
});
