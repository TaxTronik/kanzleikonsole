import { describe, expect, it } from 'vitest';
import {
  isAutomaticRefreshEnabled,
  REFRESH_INTERVAL_MS,
  shouldReloadRestoredPage,
} from '../auto-refresh';

describe('AutoRefresh-Route-Policy', () => {
  it('pollt hoechstens alle zwei Minuten', () => {
    expect(REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('pausiert automatische Voll-Refreshes auf dem schweren Mandanten-Cockpit', () => {
    expect(isAutomaticRefreshEnabled('/staff/clients/01234567-89ab-4def-8abc-0123456789ab')).toBe(
      false,
    );
    expect(isAutomaticRefreshEnabled('/staff/clients/01234567-89ab-4def-8abc-0123456789ab/')).toBe(
      false,
    );
  });

  it('laesst Listen und gezieltere Mandanten-Unterseiten automatisch aktualisieren', () => {
    expect(isAutomaticRefreshEnabled('/staff/clients')).toBe(true);
    expect(
      isAutomaticRefreshEnabled('/staff/clients/01234567-89ab-4def-8abc-0123456789ab/workflows'),
    ).toBe(true);
    expect(isAutomaticRefreshEnabled('/portal/dashboard')).toBe(true);
  });

  it('belaesst die bestehende Audit-Pause', () => {
    expect(isAutomaticRefreshEnabled('/staff/admin/audit')).toBe(false);
    expect(isAutomaticRefreshEnabled('/staff/admin/audit/archive')).toBe(false);
  });

  it('erzwingt nach Wiederherstellung aus dem Back/Forward Cache eine neue Auth-Pruefung', () => {
    expect(shouldReloadRestoredPage(true)).toBe(true);
    expect(shouldReloadRestoredPage(false)).toBe(false);
  });
});
