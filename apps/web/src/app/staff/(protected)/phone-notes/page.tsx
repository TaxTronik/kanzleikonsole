import { requireStaffPage } from '@/server/auth/staff-page';
import { withTenantContext } from '@taxtronik/db';

import { Phone } from 'lucide-react';
import { NewPhoneNoteForm } from './new-form';
import { PhoneNotesList } from '@/app/staff/(protected)/clients/[id]/phone-notes-list';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { berlinYmd } from '@/lib/fmt';

export default async function PhoneNotesPage() {
  const session = await requireStaffPage();

  const { tenantId, staffId } = session.user;

  const [notes, clients, staff, callerHistory] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Telefonnotizen gesperrter/vertraulicher Mandanten in dieser globalen
      // Liste ausblenden. clientId ist NULLABLE (mandantenlose Notizen) — die
      // OR-Form behält NULL-Zeilen, die ein reines notIn (NULL NOT IN → nicht
      // wahr) sonst verschluckte.
      const denied = await inaccessibleClientIdsFor(tx, session);
      const clientScope = denied.length
        ? { OR: [{ clientId: null }, { clientId: { notIn: denied } }] }
        : undefined;
      return Promise.all([
        tx.phoneNote.findMany({
          where: clientScope,
          orderBy: [
            { doneAt: { sort: 'asc', nulls: 'first' } },
            { readAt: 'asc' },
            { createdAt: 'desc' },
          ],
          include: {
            client: { select: { id: true, name: true } },
            reminders: {
              orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
              select: { id: true, subject: true, dueDate: true, doneAt: true },
            },
          },
          take: 100,
        }),
        tx.client.findMany({
          where: denied.length ? { id: { notIn: denied } } : undefined,
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        tx.staffUser.findMany({
          where: { active: true },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
        tx.phoneNote.findMany({
          where: clientScope,
          orderBy: { createdAt: 'desc' },
          select: { callerName: true, callerPhone: true, clientId: true },
          take: 500,
        }),
      ]);
    },
  );

  const callerMap = new Map<
    string,
    { name: string; phone: string | null; clientId: string | null }
  >();
  for (const c of callerHistory) {
    const key = c.callerName.trim().toLowerCase();
    if (!key) continue;
    if (callerMap.has(key)) continue;
    callerMap.set(key, { name: c.callerName.trim(), phone: c.callerPhone, clientId: c.clientId });
  }
  const callers = Array.from(callerMap.values()).slice(0, 100);

  const openCount = notes.filter((n) => !n.doneAt).length;
  const unreadCount = notes.filter((n) => !n.readAt && !n.doneAt).length;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Telefonzettel</h1>
        <p className="text-muted text-sm">
          Anrufe protokollieren, übertragen oder daraus Wiedervorlagen anlegen.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-3 text-sm text-secondary dark:text-disabled">
            <span className="font-medium text-primary">{openCount} offen</span>
            {unreadCount > 0 && (
              <span className="text-yellow-700 dark:text-yellow-400">
                · {unreadCount} ungelesen
              </span>
            )}
          </div>

          {notes.length === 0 ? (
            <div className="card px-6 py-16 text-center">
              <Phone className="h-12 w-12 text-disabled dark:text-secondary mx-auto mb-3" />
              <p className="text-sm text-disabled">Noch keine Telefonnotizen.</p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <PhoneNotesList
                currentStaffId={staffId}
                staffOptions={staff}
                todayYmd={berlinYmd(new Date())}
                notes={notes.map((n) => ({
                  id: n.id,
                  subject: n.subject,
                  callerName: n.callerName,
                  callerPhone: n.callerPhone,
                  body: n.body,
                  forwardToStaff: n.forwardToStaff,
                  doneAt: n.doneAt ? n.doneAt.toISOString() : null,
                  readAt: n.readAt ? n.readAt.toISOString() : null,
                  createdAt: n.createdAt.toISOString(),
                  takenByStaff: n.takenByStaff,
                  clientId: n.clientId,
                  client: n.client,
                  reminders: n.reminders.map((reminder) => ({
                    id: reminder.id,
                    subject: reminder.subject,
                    dueDate: reminder.dueDate.toISOString(),
                    doneAt: reminder.doneAt?.toISOString() ?? null,
                  })),
                }))}
              />
            </div>
          )}
        </div>

        <div className="card p-6 h-fit lg:sticky lg:top-6">
          <h2 className="text-sm font-medium text-primary mb-4">Neue Notiz</h2>
          <NewPhoneNoteForm
            clients={clients}
            staff={staff}
            currentStaffId={staffId}
            callers={callers}
          />
        </div>
      </div>
    </div>
  );
}
