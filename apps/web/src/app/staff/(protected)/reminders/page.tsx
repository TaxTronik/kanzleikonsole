// =============================================================================
// /staff/reminders — Meine Wiedervorlagen
//
// Zwei Sichten auf denselben Bestand:
//   „An mich"       — die eigene Aufgabenliste (Mitarbeitersicht)
//   „Von mir delegiert" — wo liegt was, und ist es noch in Arbeit
//                     (Berufsträger-/Partnersicht)
//
// Erledigen und Zurückholen laufen über dieselben Actions wie am Mandanten;
// die Priorität darf nur die delegierende Person (oder Admin/Partner) ändern.
// =============================================================================

import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { loadReminderOverview, type ReminderScope } from '@/server/reminders/queries';
import { RemindersOverview } from './reminders-overview';
import { NewReminderForm } from './new-reminder-form';
import { NotifyModeToggle } from './notify-mode-toggle';

interface Search {
  scope?: string;
}

const TABS: Array<{ key: ReminderScope; label: string; hint: string }> = [
  { key: 'mir', label: 'An mich', hint: 'Was du abzuarbeiten hast' },
  { key: 'vonmir', label: 'Von mir delegiert', hint: 'Wo deine Aufträge gerade liegen' },
];

export default async function RemindersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffPage();
  const { tenantId, staffId } = session.user;

  const sp = await searchParams;
  const scope: ReminderScope = sp.scope === 'vonmir' ? 'vonmir' : 'mir';

  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  const overview = await loadReminderOverview(ctx, session, scope);

  // Auswahllisten fuers Anlegen: nur zugaengliche Mandate, nur aktive
  // Mitarbeitende. Die Action prueft beides erneut — das hier ist Komfort.
  const { clients, staffOptions, notifyMode } = await withTenantContext(ctx, async (tx) => ({
    clients: await tx.client.findMany({
      where: await accessibleClientsWhereFor(tx, session),
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true },
    }),
    staffOptions: await tx.staffUser.findMany({
      where: { active: true },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true },
    }),
    notifyMode:
      (
        await tx.staffUser.findUnique({
          where: { id: staffId },
          select: { reminderNotifyMode: true },
        })
      )?.reminderNotifyMode ?? ('ALL' as const),
  }));

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <CalendarClock className="h-6 w-6 text-disabled" />
          Wiedervorlagen
        </h1>
        <p className="text-muted text-sm mt-1">
          Alle Aufgaben über Mandanten hinweg — deine eigenen und die, die du delegiert hast.
        </p>
      </div>

      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <NewReminderForm clients={clients} staffOptions={staffOptions} />
        <NotifyModeToggle initial={notifyMode} />
      </div>

      <div className="flex items-center gap-2 mb-4">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/staff/reminders?scope=${t.key}`}
            title={t.hint}
            className={scope === t.key ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <RemindersOverview
        scope={scope}
        currentStaffId={staffId}
        canPrioritizeAll={isStaffAdmin(session)}
        offen={overview.offen}
        erledigt={overview.erledigt}
      />
    </div>
  );
}
