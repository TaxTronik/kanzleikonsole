// =============================================================================
// /staff/reminders/[id] — eine Wiedervorlage im Ganzen.
//
// Hier laufen die Dinge zusammen, für die in einer Listenzeile kein Platz ist:
// der Verlauf der Kette (Nachfragen), die Wortmeldungen, die Anhänge und die
// Zuweisung an mehrere Personen.
// =============================================================================

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { loadReminderDetail } from '@/server/reminders/detail';
import { ReminderDetailView } from './reminder-detail-view';

export default async function ReminderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const detail = await loadReminderDetail(ctx, session, id);
  if (!detail) notFound();

  // Zuweisungs-Auswahl: aktive Mitarbeitende des Tenants. Die Server-Action
  // prüft zusätzlich (aktiv + selber Tenant) — das hier ist der Komfort davor.
  const staffOptions = await withTenantContext(ctx, (tx) =>
    tx.staffUser.findMany({
      where: { active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    }),
  );

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/staff/reminders" className="text-disabled hover:text-secondary shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-primary truncate">{detail.subject}</h1>
          <p className="text-xs text-muted">
            {detail.clientId ? (
              <Link href={`/staff/clients/${detail.clientId}`} className="hover:underline">
                {detail.clientName}
              </Link>
            ) : (
              'Interne Aufgabe (ohne Mandant)'
            )}
          </p>
        </div>
      </div>

      <ReminderDetailView
        detail={detail}
        currentStaffId={staffId}
        canSteer={detail.createdByStaff === staffId || isStaffAdmin(session)}
        staffOptions={staffOptions}
      />
    </div>
  );
}
