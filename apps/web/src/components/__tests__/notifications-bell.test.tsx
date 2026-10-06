// NotificationsBell nach Zuständigkeiten (Review-Befund K-04): reine Regeln
// (Zuwachs, Quittierung, Ziele, Zeiten), Quittieren nur nach
// Serverbestätigung (F-01), gerenderte Glocke, Dropdown und Hinweis. Die
// Lesefrist prüft notification-alert-timing.test.ts.

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  markRead: vi.fn(async (_input: { id: string }) => ({ ok: true })),
  markAll: vi.fn(async (_prev: unknown, _data: FormData) => ({ ok: true })),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/staff/dashboard',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/server/notifications/actions', () => ({
  markNotificationReadByIdAction: h.markRead,
  markAllNotificationsReadAction: h.markAll,
}));

import { NotificationsBell } from '../notifications-bell';
import { NotificationsDropdown } from '../notifications-bell-dropdown';
import { NotificationAlert } from '../notifications-bell-alert';
import { useNotificationAcknowledgement } from '../notifications-bell-ack';
import {
  advanceKnownUnread,
  completionToAcknowledge,
  growthTargets,
  knownUnread,
  relativeTime,
  unreadAfterRead,
  withAllRead,
  withItemRead,
  type NotificationItem,
} from '../notifications-bell-model';

const T0 = '2026-10-06T09:00:00.000Z';
const T1 = '2026-10-06T09:59:00.000Z';

function item(id: string, overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    kind: 'TASK_ASSIGNED',
    title: `Aufgabe ${id}`,
    body: `Text ${id}`,
    href: `/staff/reminders/${id}`,
    createdAt: T0,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Zuwachs gegen den bekannten Stand', () => {
  it.each([
    ['mehr ungelesene', { unread: 3, latestUnreadAt: T0 }, true],
    ['Austausch 1 offen → 1 offen (jüngerer Zeitpunkt)', { unread: 2, latestUnreadAt: T1 }, true],
    ['unverändert', { unread: 2, latestUnreadAt: T0 }, false],
    ['weniger ungelesene', { unread: 1, latestUnreadAt: T0 }, false],
    ['keine ungelesenen mehr', { unread: 0, latestUnreadAt: null }, false],
  ])('%s', (_name, next, grew) => {
    const known = knownUnread(2, T0);
    const step = advanceKnownUnread(known, next);
    expect(step.grew).toBe(grew);
    expect(step.previousLatestUnreadAt).toBe(Date.parse(T0));
    expect(step.known.unread).toBe(next.unread);
  });

  it('setzt den jüngsten Zeitpunkt nie zurück', () => {
    const step = advanceKnownUnread(knownUnread(2, T1), { unread: 0, latestUnreadAt: null });
    expect(step.known).toEqual({ unread: 0, latestUnreadAt: Date.parse(T1) });
    expect(knownUnread(0, null)).toEqual({ unread: 0, latestUnreadAt: 0 });
  });
});

describe('Quittierung auf der sichtbaren Zielseite', () => {
  const audit = item('audit', { kind: 'SYSTEM_AUDIT_OK', href: '/staff/admin/audit?x=1' });
  const visible = { pathname: '/staff/admin/audit/', hidden: false, typing: false };

  it('quittiert nur die jüngste ungelesene Abschlussmeldung dieser Seite', () => {
    expect(completionToAcknowledge([audit, item('a')], visible)).toBe(audit);
    expect(completionToAcknowledge([item('a'), audit], visible)).toBeNull();
    expect(
      completionToAcknowledge([audit], { ...visible, pathname: '/staff/dashboard' }),
    ).toBeNull();
    expect(completionToAcknowledge([{ ...audit, kind: 'TASK_ASSIGNED' }], visible)).toBeNull();
    expect(completionToAcknowledge([{ ...audit, readAt: T0 }], visible)).toBeNull();
  });

  it('quittiert nie bei verborgenem Tab oder während der Eingabe', () => {
    expect(completionToAcknowledge([audit], { ...visible, hidden: true })).toBeNull();
    expect(completionToAcknowledge([audit], { ...visible, typing: true })).toBeNull();
  });
});

describe('Ziele eines Zuwachses', () => {
  it('nimmt die seit dem bekannten Zeitpunkt neuen Einträge, sonst alle ungelesenen', () => {
    const items = [
      item('neu', { createdAt: T1, href: '/staff/requests/1' }),
      item('alt', { href: '/staff/requests/2' }),
      item('gelesen', { createdAt: T1, readAt: T1, href: '/x' }),
    ];
    expect(growthTargets(items, Date.parse(T0))).toEqual(['/staff/requests/1']);
    expect(growthTargets(items, Date.parse(T1))).toEqual([
      '/staff/requests/1',
      '/staff/requests/2',
    ]);
  });
});

describe('lokales Gelesen-Markieren', () => {
  it('markiert einen oder alle Einträge, lässt eine ungeladene Liste unangetastet', () => {
    const items = [item('a'), item('b', { readAt: T0 })];
    expect(withItemRead(items, 'a', T1)).toEqual([{ ...items[0], readAt: T1 }, items[1]]);
    expect(withAllRead(items, T1)).toEqual([{ ...items[0], readAt: T1 }, items[1]]);
    expect(withItemRead(null, 'a', T1)).toBeNull();
    expect(withAllRead(null, T1)).toBeNull();
    expect(unreadAfterRead(3)).toBe(2);
    expect(unreadAfterRead(0)).toBe(0);
  });

  it.each([
    [30_000, 'gerade eben'],
    [60_000, 'vor 1 Min.'],
    [59 * 60_000, 'vor 59 Min.'],
    [60 * 60_000, 'vor 1 Std.'],
    [24 * 60 * 60_000, 'vor 1 Tag'],
    [6 * 24 * 60 * 60_000, 'vor 6 Tagen'],
  ])('relative Zeit nach %i ms: %s', (elapsed, label) => {
    expect(relativeTime(T0, Date.parse(T0) + elapsed)).toBe(label);
  });

  it('zeigt ab sieben Tagen Datum und Uhrzeit', () => {
    expect(relativeTime(T0, Date.parse(T0) + 7 * 24 * 60 * 60_000)).toMatch(
      /^\d{2}\.\d{2}\.\d{2}, /,
    );
  });
});

describe('Quittieren nur nach Serverbestätigung (F-01)', () => {
  function probe() {
    const feed = { markReadLocally: vi.fn(), markAllReadLocally: vi.fn() };
    let ack: ReturnType<typeof useNotificationAcknowledgement> | undefined;
    function Probe() {
      ack = useNotificationAcknowledgement(feed);
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return { feed, ack: ack! };
  }

  it('markiert einen Eintrag erst nach Bestätigung und ungelesene nur einmal', async () => {
    const { feed, ack } = probe();
    await ack.markRead(item('a'));
    expect(h.markRead).toHaveBeenCalledWith({ id: 'a' });
    expect(feed.markReadLocally).toHaveBeenCalledWith('a');

    await ack.markRead(item('b', { readAt: T0 }));
    expect(h.markRead).toHaveBeenCalledTimes(1);

    h.markRead.mockResolvedValueOnce({ ok: false });
    await ack.markRead(item('c'));
    expect(feed.markReadLocally).toHaveBeenCalledTimes(1);
  });

  it('markiert alle erst nach Bestätigung', async () => {
    const { feed, ack } = probe();
    h.markAll.mockResolvedValueOnce({ ok: false });
    await ack.markAllRead();
    expect(feed.markAllReadLocally).not.toHaveBeenCalled();
    await ack.markAllRead();
    expect(h.markAll).toHaveBeenLastCalledWith(null, expect.any(FormData));
    expect(feed.markAllReadLocally).toHaveBeenCalledTimes(1);
  });
});

describe('gerenderte Glocke', () => {
  it('nennt die Anzahl im Namen und kappt die Plakette bei 99+', () => {
    const html = renderToStaticMarkup(
      <NotificationsBell initialUnread={120} initialLatestUnreadAt={T0} />,
    );
    expect(html).toContain('aria-label="120 ungelesene Benachrichtigungen"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>99+</span>');
    expect(html).not.toContain('role="dialog"');
    expect(
      renderToStaticMarkup(<NotificationsBell initialUnread={0} initialLatestUnreadAt={null} />),
    ).toContain('aria-label="Benachrichtigungen"');
  });
});

function dropdown(overrides: Partial<Parameters<typeof NotificationsDropdown>[0]> = {}) {
  return renderToStaticMarkup(
    <NotificationsDropdown
      panelId="panel"
      panelRef={{ current: null }}
      panelStyle={{ top: 10, maxHeight: 300 }}
      unread={2}
      items={[item('a'), item('b', { href: null, body: null }), item('c', { readAt: T0 })]}
      now={Date.parse(T0) + 5 * 60_000}
      accessibleDisplay={false}
      soundOn
      onToggleSound={vi.fn()}
      onMarkAllRead={vi.fn()}
      onItemClick={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe('Dropdown', () => {
  it('ist ein benannter nichtmodaler Dialog mit echtem Schließen-Knopf', () => {
    const html = dropdown();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="panel-heading"');
    expect(html).toContain('<h3 id="panel-heading"');
    expect(html).toContain('aria-label="Benachrichtigungen schließen"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('role="menu"');
    // Ganzer Feed samt Kopf und Fuß scrollt im sichtbaren Bereich.
    expect(html).toContain('style="top:10px;max-height:300px"');
    expect(html).toContain('overflow-y-auto overscroll-contain');
  });

  it('zeigt ungelesene, verlinkte und unverlinkte Einträge mit semantischer Zeit', () => {
    const html = dropdown();
    expect(html).toContain('(2 neu)');
    expect(html).toContain('Alle gelesen');
    expect(html).toMatch(/<a [^>]*href="\/staff\/reminders\/a"[^>]*>/);
    expect(html).toMatch(
      /<a [^>]*class="block"[^>]*href="\/staff\/reminders\/a"|<a [^>]*href="\/staff\/reminders\/a"[^>]*class="block"/,
    );
    expect(html).toContain('<button type="button" class="w-full text-left">');
    expect(html.match(/<span class="sr-only">Ungelesen\. <\/span>/g)).toHaveLength(2);
    expect(html).toContain(`dateTime="${T0}"`);
    expect(html).toContain('>vor 5 Min.</time>');
    expect(html).toContain('class="text-xs text-muted line-clamp-2">Text a</p>');
    expect(html).toContain('href="/staff/notifications"');
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""/);
  });

  it('zeigt im Profilmodus ungekürzte Inhalte und größere Zeiten', () => {
    const html = dropdown({ accessibleDisplay: true });
    expect(html).toContain('text-sm font-medium text-primary break-words');
    expect(html).toContain('text-sm text-muted whitespace-pre-wrap break-words');
    expect(html).toContain('class="block text-muted mt-0.5 text-sm"');
    expect(html).not.toContain(' truncate');
  });

  it('zeigt Laden, leere Liste und ohne ungelesene kein „Alle gelesen“', () => {
    expect(dropdown({ items: null })).toContain(
      '<p role="status" class="px-4 py-8 text-sm text-disabled text-center">Lade…</p>',
    );
    const empty = dropdown({ items: [], unread: 0, soundOn: false });
    expect(empty).toContain('Keine Benachrichtigungen.');
    expect(empty).not.toContain('Alle gelesen');
    expect(empty).not.toContain('neu)');
    expect(empty).not.toContain('checked=""');
  });
});

describe('Hinweis „Neue Benachrichtigung“', () => {
  const handlers = {
    onMouseEnter: vi.fn(),
    onMouseLeave: vi.fn(),
    onFocusCapture: vi.fn(),
    onBlurCapture: vi.fn(),
  };

  it('ist ein zugänglicher Statushinweis mit Öffnen-Link und Schließen-Knopf', () => {
    const html = renderToStaticMarkup(
      <NotificationAlert
        item={item('a')}
        accessibleDisplay={false}
        interactionHandlers={handlers}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('Neue Benachrichtigung');
    expect(html).toContain('class="mt-0.5 text-sm text-secondary truncate">Aufgabe a</p>');
    expect(html).toContain('href="/staff/reminders/a"');
    expect(html).toContain('Öffnen →');
    expect(html).toContain('aria-label="Hinweis schließen"');
  });

  it('kürzt im Profilmodus nicht und verlinkt nur mit Ziel', () => {
    const html = renderToStaticMarkup(
      <NotificationAlert
        item={item('b', { href: null })}
        accessibleDisplay
        interactionHandlers={handlers}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('text-sm text-secondary break-words');
    expect(html).not.toContain('Öffnen →');
  });
});

describe('Zählerabgleich über den geteilten Tab-Poller (P-08)', () => {
  const sources = [
    'notifications-bell.tsx',
    'notifications-bell-feed.ts',
    'notifications-bell-ack.ts',
    'notifications-bell-sound.ts',
    'notifications-bell-alert.tsx',
    'notifications-bell-dropdown.tsx',
    'notifications-bell-model.ts',
  ].map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  const all = sources.join('\n');

  // Verdrahtung, die ohne DOM-Testumgebung nicht ausführbar ist.
  it('lädt nur bei betroffener oder Live-Seite neu und meldet betroffene Blöcke', () => {
    expect(all).toContain('growthTargets(data.items, previousLatestUnreadAt)');
    expect(all).toContain('shouldRefreshForNotifications(pathname, targets)');
    expect(all).not.toContain('isAutomaticRefreshEnabled');
    expect(all).toContain('emitNotificationsGrew(buildNotificationSignal(data.items))');
    expect(all).toContain('if (step.grew) onUnreadGrew(step.previousLatestUnreadAt);');
    expect(all).toContain('completion && (await confirmRead(completion.id))');
  });

  it('koppelt die Lesefrist an Profilmodus und Interaktion und verankert das Dropdown', () => {
    expect(all).toContain('useNotificationAlert({ persistent: accessibleDisplay, open })');
    expect(all).toContain('interacting: hovered || focused || open');
    expect(all).toContain('alert.item && !open && (');
    expect(all).toContain("useAnchoredPanel(open, containerRef, 384, 'end')");
    expect(all).toContain('panelRef.current?.focus({ preventScroll: true })');
    expect(all).toContain(
      "event.key === 'Escape' && containerRef.current?.contains(event.target as Node)",
    );
    expect(all).toContain('event.currentTarget.contains(event.relatedTarget)');
  });

  it('nutzt keine eigenen Timer, Sichtbarkeits-Listener oder Zählabrufe', () => {
    expect(all).toContain('notificationCountPoller.subscribe(applyUnreadSummary)');
    expect(all).toContain('notificationCountPoller.pollNow()');
    expect(all).not.toContain('setInterval(');
    expect(all).not.toContain("addEventListener('visibilitychange'");
    expect(all).not.toContain("fetch('/api/staff/notifications/count'");
  });
});
