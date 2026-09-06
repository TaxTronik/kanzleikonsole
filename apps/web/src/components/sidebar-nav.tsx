'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  FileText,
  Inbox,
  Phone,
  Clock,
  Building2,
  Receipt,
  BookOpen,
  Plane,
  ScrollText,
  Shield,
  BarChart3,
  Settings,
  CalendarDays,
  Tags,
  Workflow,
  ClipboardList,
  Archive,
  IdCard,
  Mail,
  AlarmClock,
  CalendarClock,
  Dices,
  ListChecks,
  ChevronDown,
} from 'lucide-react';

// Icons werden als String-Key übergeben (Server → Client darf keine
// Komponenten-Referenzen serialisieren). Lookup hier in der Client-Component.
const ICONS = {
  LayoutDashboard,
  Users,
  FileText,
  Inbox,
  Phone,
  Clock,
  Building2,
  Receipt,
  BookOpen,
  Plane,
  ScrollText,
  Shield,
  BarChart3,
  Settings,
  CalendarDays,
  Tags,
  Workflow,
  ClipboardList,
  Archive,
  IdCard,
  Mail,
  AlarmClock,
  CalendarClock,
  Dices,
  ListChecks,
} as const;

export type NavIcon = keyof typeof ICONS;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /**
   * Wenn `true`: matcht nur den exakten Pfad. Sonst auch Subpfade
   * (`href` ist Präfix von `pathname`). Setze auf `true` bei „Übersichts"-
   * Routen, die Eltern von vielen Unterseiten sind (sonst leuchten sie
   * neben dem spezifischen Eintrag mit).
   */
  exact?: boolean;
  /**
   * Zusätzliche Pfad-Präfixe, unter denen dieser Nav-Eintrag aktiv bleibt
   * (z. B. „Kalender" soll auch auf der „Nur Steuertermine"-Unterseite
   * /staff/tax-deadlines aktiv bleiben — die liegt nicht unter /calendar).
   */
  altPaths?: string[];
}

interface Props {
  items: NavItem[];
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

function matchesPath(item: NavItem, pathname: string): boolean {
  if (pathname === item.href || pathname.startsWith(item.href + '/')) return true;
  return (item.altPaths ?? []).some((path) => pathname === path || pathname.startsWith(path + '/'));
}

/** Ein aktiver Treffer ueber ALLE Gruppen verhindert doppelte Markierungen. */
export function activeNavHref(items: readonly NavItem[], pathname: string): string | null {
  const exact = items.find((item) => pathname === item.href);
  if (exact) return exact.href;
  const candidates = items
    .filter((item) => !item.exact)
    .filter((item) => item.href !== '/staff/dashboard' && item.href !== '/portal/dashboard')
    .filter((item) => matchesPath(item, pathname))
    .sort((a, b) => b.href.length - a.href.length);
  return candidates[0]?.href ?? null;
}

function NavLinks({ items, activeHref }: { items: readonly NavItem[]; activeHref: string | null }) {
  return items.map((item) => {
    const Icon = ICONS[item.icon];
    const active = item.href === activeHref;

    return (
      <Link
        key={item.href}
        href={item.href}
        className={active ? 'nav-item active' : 'nav-item'}
        aria-current={active ? 'page' : undefined}
      >
        <Icon className="h-4 w-4" />
        {item.label}
      </Link>
    );
  });
}

export function SidebarNav({ items }: Props) {
  const pathname = usePathname();
  return <NavLinks items={items} activeHref={activeNavHref(items, pathname)} />;
}

/**
 * Gemeinsame, responsive Staff-/Portal-Navigation. Gruppen lassen sich auf
 * schmalen Viewports einklappen; die Gruppe des aktiven Pfads wird bei jeder
 * Navigation wieder geoeffnet. Der Zustand bleibt absichtlich lokal und
 * benoetigt weder DB- noch LocalStorage-Migration.
 */
export function GroupedSidebarNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeHref = activeNavHref(items, pathname);
  const activeGroupId = groups.find((group) =>
    group.items.some((item) => item.href === activeHref),
  )?.id;
  const [groupState, setGroupState] = useState<{
    collapsed: Set<string>;
    /** Aktive Gruppe darf nach explizitem Klick auf genau diesem Pfad zu sein. */
    collapsedWhileActive: Set<string>;
  }>(() => ({ collapsed: new Set(), collapsedWhileActive: new Set() }));

  return (
    <div className="space-y-2">
      {groups.map((group) => {
        const activeDismissalKey = `${pathname}:${group.id}`;
        // Wird ein zuvor geschlossener Bereich durch Navigation aktiv, oeffnet
        // er sich wieder automatisch. Ein bewusster Klick darf ihn auf dem
        // aktuellen Pfad trotzdem schliessen.
        const open =
          !groupState.collapsed.has(group.id) ||
          (group.id === activeGroupId && !groupState.collapsedWhileActive.has(activeDismissalKey));
        const regionId = `sidebar-group-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={`${regionId}-label`}>
            <button
              id={`${regionId}-label`}
              type="button"
              className="flex w-full items-center justify-between rounded px-3 py-1 text-left text-xs font-medium uppercase tracking-wide text-disabled hover:bg-gray-50 hover:text-secondary"
              aria-expanded={open}
              aria-controls={regionId}
              onClick={() =>
                setGroupState((current) => {
                  const collapsed = new Set(current.collapsed);
                  const collapsedWhileActive = new Set(current.collapsedWhileActive);
                  if (open) {
                    collapsed.add(group.id);
                    if (group.id === activeGroupId) {
                      collapsedWhileActive.add(activeDismissalKey);
                    }
                  } else {
                    collapsed.delete(group.id);
                    collapsedWhileActive.delete(activeDismissalKey);
                  }
                  return { collapsed, collapsedWhileActive };
                })
              }
            >
              <span>{group.label}</span>
              <ChevronDown
                className={
                  open
                    ? 'h-3.5 w-3.5 rotate-180 transition-transform'
                    : 'h-3.5 w-3.5 transition-transform'
                }
                aria-hidden="true"
              />
            </button>
            <div id={regionId} hidden={!open} className="mt-0.5">
              <NavLinks items={group.items} activeHref={activeHref} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
