// @vitest-environment jsdom
// Verdrahtung der Benachrichtigungsglocke als Verhaltenstest in jsdom (B-08,
// Welle 15) statt Quelltextprüfung: geteilter Tab-Poller statt eigener Timer
// (P-08), Zuwachs → Kurzliste, Live-Ereignis und Refresh nur bei betroffener
// Seite, Quittung einer Abschlussmeldung nur nach Serverbestätigung (F-01),
// Lesefrist des Hinweises und das verankerte, fokussierte Dropdown. Die reinen
// Regeln prüft notifications-bell.test.tsx, die Zeiten
// notification-alert-timing.test.ts.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnreadSummary } from '@/lib/notification-count-poller';

const m = vi.hoisted(() => ({
  pathname: '/staff/requests',
  refresh: vi.fn(),
  // Wie in Next stabil über Renderings (der Feed-Hook hängt seine Callbacks daran).
  router: null as unknown as { refresh: () => void; push: () => void },
  listener: null as null | ((summary: UnreadSummary) => void),
  unsubscribe: vi.fn(),
  pollNow: vi.fn(async () => undefined),
  markRead: vi.fn(async (_input: { id: string }) => ({ ok: true })),
  emitGrew: vi.fn(),
  shouldRefresh: vi.fn(),
  sound: vi.fn(),
  anchored: vi.fn(),
  schedule: vi.fn((_options: { persistent: boolean; interacting: boolean }) => () => undefined),
}));

m.router = { refresh: (...args: unknown[]) => m.refresh(...args), push: () => undefined };
vi.mock('next/navigation', () => ({
  usePathname: () => m.pathname,
  useRouter: () => m.router,
}));
vi.mock('@/lib/notification-count-poller', () => ({
  notificationCountPoller: {
    subscribe: (listener: (summary: UnreadSummary) => void) => {
      m.listener = listener;
      return m.unsubscribe;
    },
    pollNow: m.pollNow,
  },
}));
vi.mock('@/server/notifications/actions', () => ({
  markNotificationReadByIdAction: m.markRead,
  markAllNotificationsReadAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/live-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/live-events')>()),
  emitNotificationsGrew: m.emitGrew,
}));
vi.mock('@/lib/live-refresh-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/live-refresh-policy')>();
  return {
    ...actual,
    shouldRefreshForNotifications: (pathname: string, targets: string[]) => {
      m.shouldRefresh(pathname, targets);
      return actual.shouldRefreshForNotifications(pathname, targets);
    },
  };
});
vi.mock('@/lib/notification-sound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-sound')>()),
  playNotificationSound: m.sound,
}));
vi.mock('../ui/use-anchored-panel', () => ({
  useAnchoredPanel: (...args: unknown[]) => {
    m.anchored(...args);
    return { top: 48, right: 0, width: 384 };
  },
}));
vi.mock('../ui/notification-alert-timing', () => ({
  scheduleNotificationAlertDismiss: m.schedule,
}));

import { buildNotificationSignal } from '@/lib/live-events';
import { AccessibleDisplayProvider } from '../accessible-display';
import { NotificationsBell } from '../notifications-bell';
import type { NotificationItem } from '../notifications-bell-model';

const T0 = '2026-10-06T09:00:00.000Z';
const T1 = '2026-10-06T09:59:00.000Z';

function item(id: string, overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    kind: 'TASK_ASSIGNED',
    title: `Aufgabe ${id}`,
    body: null,
    href: `/staff/requests/${id}`,
    createdAt: T1,
    readAt: null,
    ...overrides,
  } as NotificationItem;
}

let recent: { unread: number; latestUnreadAt: string | null; items: NotificationItem[] };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.pathname = '/staff/requests';
  m.listener = null;
  recent = { unread: 3, latestUnreadAt: T1, items: [item('neu'), item('alt', { createdAt: T0 })] };
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => recent }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function bell(accessibleDisplay = false) {
  return (
    <AccessibleDisplayProvider
      initialEnabled={accessibleDisplay}
      saveAction={async () => ({ ok: true })}
    >
      <NotificationsBell initialUnread={2} initialLatestUnreadAt={T0} />
      <button type="button">Außerhalb</button>
    </AccessibleDisplayProvider>
  );
}

async function poll(summary: UnreadSummary) {
  await act(async () => {
    m.listener!(summary);
  });
}

describe('Zählerabgleich über den geteilten Tab-Poller (P-08)', () => {
  it('abonniert nur den Poller, ohne eigene Timer, Sichtbarkeits-Listener oder Zählabrufe', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const addListener = vi.spyOn(document, 'addEventListener');
    const view = render(bell());
    expect(m.listener).toBeTypeOf('function');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(addListener.mock.calls.map(([type]) => type)).not.toContain('visibilitychange');
    expect(fetchMock).not.toHaveBeenCalled();

    view.unmount();
    expect(m.unsubscribe).toHaveBeenCalledOnce();
  });

  it('zählt nach einer Navigation sofort über den Poller neu', () => {
    const view = render(bell());
    expect(m.pollNow).not.toHaveBeenCalled();
    m.pathname = '/staff/clients';
    view.rerender(bell());
    expect(m.pollNow).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/staff/notifications/count', expect.anything());
  });

  it('übernimmt den Zähler ohne Zuwachs ohne Kurzliste, Ton oder Refresh', async () => {
    render(bell());
    await poll({ unread: 1, latestUnreadAt: T0 });
    expect(screen.getByRole('button', { name: '1 ungelesene Benachrichtigungen' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.sound).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
  });
});

describe('Zuwachs', () => {
  it('lädt die Kurzliste, meldet die betroffenen Ziele und lädt nur eine betroffene Seite neu', async () => {
    m.pathname = '/staff/requests/neu';
    render(bell());
    await poll({ unread: 3, latestUnreadAt: T1 });

    await waitFor(() => expect(m.emitGrew).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith('/api/staff/notifications/recent', {
      cache: 'no-store',
    });
    // Ziele seit dem bekannten Zeitpunkt T0: nur der neue Eintrag.
    expect(m.shouldRefresh).toHaveBeenCalledWith('/staff/requests/neu', ['/staff/requests/neu']);
    expect(m.refresh).toHaveBeenCalledOnce();
    expect(m.sound).toHaveBeenCalledOnce();
    expect(m.emitGrew).toHaveBeenCalledWith(buildNotificationSignal(recent.items));
    // Hinweis mit dem jüngsten ungelesenen Eintrag.
    expect(screen.getByText('Neue Benachrichtigung')).toBeTruthy();
    expect(screen.getByText('Aufgabe neu')).toBeTruthy();
  });

  it('lädt eine nicht betroffene Seite nicht neu', async () => {
    m.pathname = '/staff/clients';
    render(bell());
    await poll({ unread: 3, latestUnreadAt: T1 });
    await waitFor(() => expect(m.emitGrew).toHaveBeenCalledOnce());
    expect(m.shouldRefresh).toHaveBeenCalledWith('/staff/clients', ['/staff/requests/neu']);
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('quittiert eine Abschlussmeldung auf ihrer sichtbaren Zielseite erst nach Serverbestätigung', async () => {
    m.pathname = '/staff/admin/audit';
    const audit = item('audit', { kind: 'SYSTEM_AUDIT_OK', href: '/staff/admin/audit' });
    recent = { unread: 3, latestUnreadAt: T1, items: [audit] };
    render(bell());
    await poll({ unread: 3, latestUnreadAt: T1 });

    await waitFor(() => expect(m.refresh).toHaveBeenCalledOnce());
    expect(m.markRead).toHaveBeenCalledWith({ id: 'audit' });
    expect(screen.getByRole('button', { name: '2 ungelesene Benachrichtigungen' })).toBeTruthy();
    expect(m.sound).not.toHaveBeenCalled();
    expect(screen.queryByText('Neue Benachrichtigung')).toBeNull();
    const [signal] = m.emitGrew.mock.calls[0]!;
    expect(signal).toEqual(buildNotificationSignal([{ ...audit, readAt: 'gelesen' }]));
  });

  it('behandelt eine abgelehnte Quittung wie einen normalen Zuwachs', async () => {
    m.pathname = '/staff/admin/audit';
    m.markRead.mockResolvedValueOnce({ ok: false });
    recent = {
      unread: 3,
      latestUnreadAt: T1,
      items: [item('audit', { kind: 'SYSTEM_AUDIT_OK', href: '/staff/admin/audit' })],
    };
    render(bell());
    await poll({ unread: 3, latestUnreadAt: T1 });
    await waitFor(() => expect(m.sound).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '3 ungelesene Benachrichtigungen' })).toBeTruthy();
  });
});

describe('Hinweis und Dropdown', () => {
  it('hält den Hinweis im Profilmodus offen und pausiert ihn bei Interaktion und offenem Dropdown', async () => {
    render(bell(true));
    await poll({ unread: 3, latestUnreadAt: T1 });
    await screen.findByText('Neue Benachrichtigung');
    expect(m.schedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ persistent: true, interacting: false }),
    );

    fireEvent.mouseEnter(screen.getByRole('status'));
    expect(m.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: true }));
    fireEvent.mouseLeave(screen.getByRole('status'));
    expect(m.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: false }));

    fireEvent.click(screen.getByRole('button', { name: /ungelesene Benachrichtigungen/ }));
    // Das Dropdown verdeckt den Hinweis, die Lesefrist pausiert.
    expect(screen.queryByText('Neue Benachrichtigung')).toBeNull();
    expect(m.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: true }));
  });

  it('verankert das Dropdown an der Glocke und fokussiert es beim Öffnen', () => {
    render(bell());
    const trigger = screen.getByRole('button', { name: '2 ungelesene Benachrichtigungen' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: /Benachrichtigungen/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(dialog.id);
    expect(m.anchored).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ current: expect.any(HTMLDivElement) }),
      384,
      'end',
    );
    expect(dialog.style.width).toBe('384px');
    expect(document.activeElement).toBe(dialog);
  });

  it('schließt mit Escape nur aus der Glocke heraus und gibt den Fokus zurück', () => {
    render(bell());
    const trigger = screen.getByRole('button', { name: '2 ungelesene Benachrichtigungen' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('schließt, wenn der Fokus die Glocke verlässt, nicht bei Fokus im Dropdown', () => {
    render(bell());
    const trigger = screen.getByRole('button', { name: '2 ungelesene Benachrichtigungen' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    fireEvent.blur(dialog, { relatedTarget: trigger });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.blur(dialog, { relatedTarget: screen.getByRole('button', { name: 'Außerhalb' }) });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
