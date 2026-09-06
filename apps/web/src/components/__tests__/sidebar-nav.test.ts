import { describe, expect, it } from 'vitest';
import { activeNavHref, type NavItem } from '../sidebar-nav';

const items: NavItem[] = [
  { href: '/staff/dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { href: '/staff/knowledge', label: 'Wissen', icon: 'BookOpen' },
  { href: '/staff/knowledge/context', label: 'Kontext', icon: 'BookOpen' },
  {
    href: '/staff/calendar',
    label: 'Kalender',
    icon: 'CalendarDays',
    altPaths: ['/staff/tax-deadlines'],
  },
  { href: '/staff/admin', label: 'Administration', icon: 'Shield', exact: true },
];

describe('GroupedSidebarNav: aktive Ziele', () => {
  it('waehlt gruppenuebergreifend den spezifischsten Pfad', () => {
    expect(activeNavHref(items, '/staff/knowledge/context/article-1')).toBe(
      '/staff/knowledge/context',
    );
  });

  it('respektiert alternative Pfade und exact-Eintraege', () => {
    expect(activeNavHref(items, '/staff/tax-deadlines/2026')).toBe('/staff/calendar');
    expect(activeNavHref(items, '/staff/admin')).toBe('/staff/admin');
    expect(activeNavHref(items, '/staff/admin/users')).toBeNull();
  });

  it('markiert die Dashboard-Wurzel nicht auf beliebigen Unterseiten', () => {
    expect(activeNavHref(items, '/staff/dashboard/widget')).toBeNull();
  });
});
