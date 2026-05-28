import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { SettingsNav } from './nav';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start gap-4 mb-6">
        <Link
          href="/staff/admin"
          className="text-disabled hover:text-secondary mt-1"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">
            Einstellungen
          </h1>
          <p className="text-muted text-sm">
            Grundkonfiguration der Kanzlei — Erscheinungsbild, Module, E-Mail-Versand, Integrationen.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[16rem_1fr] gap-6">
        <aside className="lg:sticky lg:top-6 self-start">
          <SettingsNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
