// =============================================================================
// /staff/admin/privacy — Kanzlei-Datenschutzangaben (füllen die Platzhalter der
// Datenschutzhinweise). Admin/Partner-only.
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { readPrivacyConfig, PRIVACY_NOTICE_VERSION } from '@/server/privacy/notice';
import { PrivacyConfigForm } from './config-form';

export default async function AdminPrivacyPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');
  const { tenantId, staffId } = session.user;

  const config = await readPrivacyConfig({ tenantId, actorId: staffId, actorType: 'STAFF' });

  return (
    <div className="p-8 max-w-2xl">
      <Link href="/staff/admin" className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>
      <div className="mb-6 flex items-start gap-3">
        <ShieldCheck className="h-6 w-6 text-brand-600 mt-1" />
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Kanzlei-Datenschutzangaben</h1>
          <p className="text-muted text-sm">
            Diese Angaben füllen die Datenschutzhinweise (Teil A, Standardtext
            Version {PRIVACY_NOTICE_VERSION}), die Mandanten bei der Einwilligung
            angezeigt und als Nachweis eingefroren werden. Die Empfängerliste
            (Abschnitt 5) stammt automatisch aus{' '}
            <Link href="/staff/service-providers" className="underline">Dienstleister (AVV)</Link>.
          </p>
        </div>
      </div>
      <PrivacyConfigForm initial={config} />
    </div>
  );
}
