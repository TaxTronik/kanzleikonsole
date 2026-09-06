import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const autoRefresh = readFileSync(
  new URL('../audit-verify-auto-refresh.tsx', import.meta.url),
  'utf8',
);
const actions = readFileSync(new URL('../actions.ts', import.meta.url), 'utf8');
const acknowledger = readFileSync(
  new URL('../audit-notification-acknowledger.tsx', import.meta.url),
  'utf8',
);

describe('AUDIT-VERIFY-ALERT-001: Audit-Chain-Verifikation', () => {
  it('navigiert nach dem Worker-Ergebnis aus dem Queue-Zustand heraus', () => {
    expect(autoRefresh).toContain("router.replace('/staff/admin/audit', { scroll: false })");
    expect(autoRefresh).not.toContain('router.refresh()');
  });

  it('schließt eine bereits auf der grünen Audit-Karte sichtbare Erfolgsmeldung', () => {
    expect(actions).toContain("kinds: ['SYSTEM_AUDIT_OK']");
    expect(actions).toContain("hrefs: ['/staff/admin/audit']");
    expect(actions).toContain('staffIds: [staffId]');
    expect(acknowledger).toContain('emitNotificationsChanged();');
  });
});
