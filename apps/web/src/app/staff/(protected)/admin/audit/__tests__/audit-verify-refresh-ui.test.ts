// @vitest-environment jsdom
// Fachkatalog: AUDIT-VERIFY-ALERT-001
// Audit-Chain-Verifikation im Browser als Verhaltenstest (B-08, Welle 15)
// statt Quelltextprüfung: Polling bis zum Worker-Ergebnis und Quittieren der
// Erfolgsmeldung über die echte Server-Action. Der Dateiname bleibt, weil die
// Regel ihn als test_ref führt; daher createElement statt JSX.
import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onNotificationsChanged } from '@/lib/live-events';

const h = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  withStaff: vi.fn(),
  resolveNotifications: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
  redirect: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: h.resolveNotifications,
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({
  readTenantSettingValue: vi.fn(),
  writeTenantSettingValue: vi.fn(),
}));
vi.mock('@taxtronik/evidence', () => ({
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY: 'audit.recovery',
  AUDIT_VERIFY_RESULT_SETTING_KEY: 'audit.verify',
}));
vi.mock('@/server/jobs/audit-verify-queue', () => ({ enqueueAuditVerify: vi.fn() }));
vi.mock('@/server/actions/audit', () => ({ audit: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  staffAction: vi.fn(),
  withStaff: h.withStaff,
}));

import { AuditVerifyAutoRefresh } from '../audit-verify-auto-refresh';
import { AuditNotificationAcknowledger } from '../audit-notification-acknowledger';

const TX = { marker: 'tx' };

function statusResponse(done: boolean) {
  return { ok: true, json: async () => ({ done }) };
}

describe('AUDIT-VERIFY-ALERT-001: Audit-Chain-Verifikation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Nachgebildetes withStaff: Gate bestanden, Ergebnis wie im Original.
    h.withStaff.mockImplementation(async (fn, _opts) => ({
      ok: true,
      ...(await fn(TX, { tenantId: 'tenant-1', staffId: 'staff-1' })),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('navigiert nach dem Worker-Ergebnis aus dem Queue-Zustand heraus', async () => {
    fetchMock
      .mockResolvedValueOnce(statusResponse(false))
      .mockResolvedValueOnce(statusResponse(true));
    render(
      createElement(AuditVerifyAutoRefresh, {
        requestId: 'req-1',
        queuedAt: '2026-10-12T10:00:00.000Z',
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/staff/admin/audit/verify-status?requestId=req-1&queuedAt=2026-10-12T10%3A00%3A00.000Z',
      { cache: 'no-store' },
    );
    expect(h.replace).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(h.replace).toHaveBeenCalledExactlyOnceWith('/staff/admin/audit', { scroll: false });
    expect(h.refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pollt ohne angestoßene Prüfung nicht und meldet einen ausbleibenden Worker sichtbar', async () => {
    const { rerender } = render(createElement(AuditVerifyAutoRefresh, { requestId: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(statusResponse(false));
    rerender(createElement(AuditVerifyAutoRefresh, { requestId: 'req-2', queuedAt: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(303_000);
    });
    expect(screen.getByText(/Läuft der Hintergrund-Dienst \(Worker\)\?/)).toBeTruthy();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('schließt eine bereits auf der grünen Audit-Karte sichtbare Erfolgsmeldung', async () => {
    const changed = vi.fn();
    const unsubscribe = onNotificationsChanged(changed);
    h.resolveNotifications.mockResolvedValue(1);

    render(createElement(AuditNotificationAcknowledger, { resultKey: 'run-1' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(h.withStaff).toHaveBeenCalledWith(expect.any(Function), { requireAdmin: true });
    expect(h.resolveNotifications).toHaveBeenCalledExactlyOnceWith(TX, {
      tenantId: 'tenant-1',
      hrefs: ['/staff/admin/audit'],
      kinds: ['SYSTEM_AUDIT_OK'],
      staffIds: ['staff-1'],
    });
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('meldet keine Änderung, wenn nichts quittiert wurde oder kein Ergebnis sichtbar ist', async () => {
    const changed = vi.fn();
    const unsubscribe = onNotificationsChanged(changed);
    h.resolveNotifications.mockResolvedValue(0);

    const { rerender } = render(createElement(AuditNotificationAcknowledger, { resultKey: null }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(h.withStaff).not.toHaveBeenCalled();

    rerender(createElement(AuditNotificationAcknowledger, { resultKey: 'run-2' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(h.resolveNotifications).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });
});
