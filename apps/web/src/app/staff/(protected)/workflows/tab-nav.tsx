'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Play, FileText } from 'lucide-react';

const TABS = [
  { href: '/staff/workflows', label: 'Aktive Vorgänge', icon: Play, exact: true },
  { href: '/staff/workflows/templates', label: 'Vorlagen', icon: FileText, exact: false },
];

export function WorkflowsTabNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="flex gap-1 border-b border-default mb-6">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={
              active
                ? 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 border-brand-600 text-brand-700 dark:text-brand-300 -mb-px'
                : 'inline-flex items-center gap-1.5 px-4 py-2 text-sm text-secondary dark:text-disabled hover:text-primary border-b-2 border-transparent -mb-px'
            }
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
