// Review-Befund P-08: Die Glocke lädt bei neuen Benachrichtigungen nur noch
// Live-Seiten oder die Seite voll neu, die die neue Benachrichtigung betrifft.

import { describe, expect, it } from 'vitest';
import { notificationTargetsPage, shouldRefreshForNotifications } from '../live-refresh-policy';

const ID = '01234567-89ab-4def-8abc-0123456789ab';

describe('notificationTargetsPage', () => {
  it.each([
    [`/staff/requests/${ID}`, `/staff/requests/${ID}`, true],
    [`/staff/requests/${ID}`, '/staff/requests', true],
    [`/staff/requests/${ID}?tab=antworten#ende`, '/staff/requests/', true],
    ['/staff/phone-notes', '/staff/phone-notes', true],
    [`/staff/requests/${ID}`, '/staff/request', false],
    [`/staff/requests/${ID}`, '/staff/inbox', false],
    [`/staff/requests/${ID}`, '/staff', false],
    ['https://evil.example/staff/requests', '/staff/requests', false],
    ['//evil.example/staff/requests', '/staff/requests', false],
    [null, '/staff/requests', false],
  ])('%s betrifft %s: %s', (href, pathname, expected) => {
    expect(notificationTargetsPage(href, pathname)).toBe(expected);
  });
});

describe('shouldRefreshForNotifications', () => {
  it('lädt Live-Seiten immer, auch ohne bekannte Ziele', () => {
    expect(shouldRefreshForNotifications('/staff/dashboard', [])).toBe(true);
    expect(shouldRefreshForNotifications('/staff/work', ['/staff/admin/screening'])).toBe(true);
  });

  it('lädt eine Seite, auf die eine neue Benachrichtigung zeigt', () => {
    expect(shouldRefreshForNotifications('/staff/requests', [`/staff/requests/${ID}`])).toBe(true);
    expect(shouldRefreshForNotifications(`/staff/inbox/${ID}`, [`/staff/inbox/${ID}`])).toBe(true);
  });

  it('lässt unbeteiligte Seiten in Ruhe', () => {
    expect(shouldRefreshForNotifications('/staff/gwg', [`/staff/requests/${ID}`])).toBe(false);
    expect(shouldRefreshForNotifications('/staff/year-end', [null, '/staff/dashboard'])).toBe(
      false,
    );
    expect(shouldRefreshForNotifications('/staff/requests', [])).toBe(false);
  });

  it('lädt die Benachrichtigungsliste bei jedem neuen Eintrag', () => {
    expect(shouldRefreshForNotifications('/staff/notifications', [null])).toBe(true);
    expect(shouldRefreshForNotifications('/staff/notifications', [])).toBe(false);
  });

  it('lädt Cockpit, GwG-Seite und Audit nie voll neu (Blöcke/Poller laden selbst nach)', () => {
    expect(shouldRefreshForNotifications(`/staff/clients/${ID}`, [`/staff/clients/${ID}`])).toBe(
      false,
    );
    expect(
      shouldRefreshForNotifications(`/staff/clients/${ID}/gwg`, [`/staff/clients/${ID}/gwg`]),
    ).toBe(false);
    expect(shouldRefreshForNotifications('/staff/admin/audit', ['/staff/admin/audit'])).toBe(false);
    // Unterseiten des Mandanten ohne eigene Nachlade-Logik werden gezielt neu geladen.
    expect(
      shouldRefreshForNotifications(`/staff/clients/${ID}/workflows`, [
        `/staff/clients/${ID}/workflows`,
      ]),
    ).toBe(true);
  });
});
