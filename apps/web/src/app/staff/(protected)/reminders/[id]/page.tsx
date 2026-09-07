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

export default async function ReminderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ commentsPage?: string; attachmentsPage?: string }>;
}) {
  const { id } = await params;
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };

  const search = await searchParams;
  const detail = await loadReminderDetail(ctx, session, id, {
    commentsPage: Number(search.commentsPage ?? 1),
    attachmentsPage: Number(search.attachmentsPage ?? 1),
  });
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
    <div className="p-4 sm:p-8 max-w-7xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/staff/reminders"
          aria-label="Zur Ticketübersicht"
          className="text-disabled hover:text-secondary shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-primary break-words">
            <span className="text-muted">#{detail.ticketNumber}</span> {detail.subject}
          </h1>
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
        key={detail.id}
        detail={detail}
        currentStaffId={staffId}
        canSteer={detail.createdByStaff === staffId || isStaffAdmin(session)}
        staffOptions={staffOptions}
      />
    </div>
  );
}
