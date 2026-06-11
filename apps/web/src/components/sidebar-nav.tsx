'use client';

import Link from 'next/link';
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
  Dices,
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
  Dices,
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

export function SidebarNav({ items }: Props) {
  const pathname = usePathname();

  // Hilfsfunktion: matcht item.href oder einen seiner altPaths gegen pathname.
  const matches = (i: NavItem): boolean => {
    if (pathname === i.href || pathname.startsWith(i.href + '/')) return true;
    return (i.altPaths ?? []).some(
      (p) => pathname === p || pathname.startsWith(p + '/'),
    );
  };

  // Längsten Prefix-Match über alle Items dieser Liste finden. So leuchtet
  // bei `/staff/workflows/templates` nur die Template-Zeile, nicht zusätzlich
  // die übergeordnete „Workflows"-Zeile.
  const bestPrefixHref = (() => {
    const candidates = items
      .filter((i) => !i.exact)
      .filter((i) => i.href !== '/staff/dashboard' && i.href !== '/portal/dashboard')
      .filter(matches);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.href.length - a.href.length);
    return candidates[0]!.href;
  })();

  return (
    <>
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const isExact = item.href === pathname;
        const isPrefix = !item.exact && !isExact && item.href === bestPrefixHref;
        const active = isExact || isPrefix;

        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              active
                ? 'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium bg-brand-50 text-brand-700 transition-colors'
                : 'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-secondary hover:bg-gray-100 hover:text-primary transition-colors'
            }
          >
            <Icon className={active ? 'h-4 w-4 text-brand-700' : 'h-4 w-4 text-muted'} />
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
