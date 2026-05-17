'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Palette,
  Boxes,
  MapPin,
  Building,
  Mail,
  Plug,
  ShieldCheck,
  Workflow,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';

interface SectionLink {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const SECTIONS: SectionLink[] = [
  { href: '/staff/admin/settings/branding',     label: 'Erscheinungsbild', description: 'Logo, Akzentfarbe, Anzeigename', icon: Palette },
  { href: '/staff/admin/settings/modules',      label: 'Module',            description: 'BWA / Vollmachten / Rechnungen …',   icon: Boxes },
  { href: '/staff/admin/settings/portal',       label: 'Mandantenportal',   description: 'Feature-Toggles fürs Mandanten-UI', icon: LayoutDashboard },
  { href: '/staff/admin/settings/region',       label: 'Bundesland',        description: 'Feiertage für Steuertermine',       icon: MapPin },
  { href: '/staff/admin/settings/seller',       label: 'Kanzlei-Stammdaten',description: 'Für XRechnung / ZUGFeRD',           icon: Building },
  { href: '/staff/admin/settings/mail',         label: 'E-Mail-Versand',    description: 'SMTP, Test-Mail',                   icon: Mail },
  { href: '/staff/admin/settings/n8n',          label: 'n8n-Bridge',        description: 'Webhooks, HMAC, Workflow-Import',   icon: Workflow },
  { href: '/staff/admin/settings/evidence',     label: 'Zeitstempel (TSA)', description: 'RFC-3161 für Audit-Chain',          icon: ShieldCheck },
  { href: '/staff/admin/settings/integrations', label: 'Integrationen',     description: 'S3, Redis, n8n, Health-Status',     icon: Plug },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="space-y-1">
      {SECTIONS.map((s) => {
        const active = pathname === s.href || pathname?.startsWith(s.href + '/');
        const Icon = s.icon;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={
              active
                ? 'flex items-start gap-3 px-3 py-2.5 rounded-md bg-brand-50 dark:bg-brand-900/30 text-brand-800 dark:text-brand-200 border-l-2 border-brand-600'
                : 'flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800/60 text-gray-700 dark:text-gray-300 border-l-2 border-transparent'
            }
          >
            <Icon className={active ? 'h-4 w-4 mt-0.5 text-brand-700 dark:text-brand-300 shrink-0' : 'h-4 w-4 mt-0.5 text-gray-400 shrink-0'} />
            <div className="min-w-0">
              <div className="text-sm font-medium">{s.label}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{s.description}</div>
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
