import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { SettingsNav } from './nav';
import { SettingsFormGuard } from '@/components/settings-form-guard';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  await requireStaffPage({ admin: true });

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Einstellungen</h1>
          <p className="text-muted text-sm">
            Grundkonfiguration der Kanzlei — Erscheinungsbild, Module, E-Mail-Versand,
            Integrationen.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[16rem_1fr] gap-6">
        <aside className="lg:sticky lg:top-6 self-start">
          <SettingsNav />
        </aside>
        <SettingsFormGuard>{children}</SettingsFormGuard>
      </div>
    </div>
  );
}
