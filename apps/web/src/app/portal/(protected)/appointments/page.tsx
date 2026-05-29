// =============================================================================
// /portal/appointments — Mandanten-Terminanfragen
//
// Mandant sieht NUR seine eigenen Termine und Anfragen — keine Einsicht in
// den Kanzleikalender (DSGVO-Vorgabe). Formular: 1–3 Wunschtermine + Anliegen.
// =============================================================================

import { redirect } from 'next/navigation';
import { CalendarDays, Check, Clock } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { portalBaseUrl } from '@taxtronik/config';
import { AppointmentRequestForm } from './request-form';
import { CancelRequestButton } from './cancel-request-button';
import { IcalSubscribe } from './ical-subscribe';
import { signIcalToken } from '@/server/ical/feed';
import { fmtDateMedium, fmtDateTimeMedium } from '@/lib/fmt';


const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Wird geprüft',
  ACCEPTED: 'Bestätigt',
  REJECTED: 'Abgelehnt',
  CANCELLED: 'Abgesagt',
};

export default async function PortalAppointmentsPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const features = await readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' });

  const data = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    async (tx) => {
      const [appointments, requests, staffList] = await Promise.all([
        tx.appointment.findMany({
          where: {
            clientId,
            status: { not: 'CANCELLED' },
            endsAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          orderBy: { startsAt: 'asc' },
          include: { owner: { select: { fullName: true } } },
        }),
        tx.appointmentRequest.findMany({
          where: { clientId },
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            preferredStaff: { select: { fullName: true } },
            decidedBy: { select: { fullName: true } },
          },
        }),
        // Mitarbeiter, die für diesen Mandanten zuständig sind (Berufsträger + Hauptbearbeiter)
        tx.staffUser.findMany({
          where: {
            active: true,
            responsibilities: {
              some: { clientId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
            },
          },
          orderBy: { fullName: 'asc' },
          select: { id: true, fullName: true },
        }),
      ]);
      return { appointments, requests, staffList };
    },
  );

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="page-title">
          <CalendarDays className="h-6 w-6 text-brand-600" />
          Termine
        </h1>
        <p className="text-muted text-sm">
          Hier sehen Sie Ihre vereinbarten Termine und können neue anfragen.
        </p>
      </div>

      <IcalSubscribe url={`${portalBaseUrl}/api/portal/ical/${signIcalToken(contactId)}`} />

      {features.appointmentRequests && (
        <div className="mb-6">
          <AppointmentRequestForm staffOptions={data.staffList} />
        </div>
      )}

      <div className="card overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Bestätigte Termine</h2>
        </div>
        {data.appointments.length === 0 ? (
          <p className="px-6 py-8 text-sm text-disabled text-center">Aktuell keine Termine.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.appointments.map((a) => {
              const past = a.endsAt.getTime() < Date.now();
              return (
                <li key={a.id} className={'px-6 py-3 ' + (past ? 'opacity-60' : '')}>
                  <p className="text-sm font-medium text-primary">{a.title}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {fmtDateTimeMedium(a.startsAt)} – {fmtDateTimeMedium(a.endsAt)}
                  </p>
                  <p className="text-xs text-muted">
                    Bearbeiter: {a.owner.fullName}
                    {a.location && <span className="ml-2">· {a.location}</span>}
                  </p>
                  {a.notes && (
                    <p className="text-xs text-secondary dark:text-disabled mt-1 whitespace-pre-wrap">{a.notes}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-default">
          <h2 className="text-sm font-medium text-primary">Meine Anfragen</h2>
        </div>
        {data.requests.length === 0 ? (
          <p className="px-6 py-8 text-sm text-disabled text-center">Noch keine Anfragen.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.requests.map((r) => {
              const slots = (r.proposedSlots as Array<{ startsAt: string; endsAt: string }>) ?? [];
              return (
                <li key={r.id} className="px-6 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-primary flex items-center gap-2 flex-wrap">
                        {r.subject}
                        {r.status === 'PENDING' && (
                          <span className="badge-yellow text-[10px] inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {STATUS_LABELS[r.status]}
                          </span>
                        )}
                        {r.status === 'ACCEPTED' && (
                          <span className="badge-green text-[10px] inline-flex items-center gap-1">
                            <Check className="h-3 w-3" />
                            {STATUS_LABELS[r.status]}
                          </span>
                        )}
                        {r.status === 'REJECTED' && (
                          <span className="badge-red text-[10px]">{STATUS_LABELS[r.status]}</span>
                        )}
                        {r.status === 'CANCELLED' && (
                          <span className="badge-gray text-[10px]">{STATUS_LABELS[r.status]}</span>
                        )}
                      </p>
                      <p className="text-[11px] text-disabled mt-0.5">
                        {fmtDateMedium(r.createdAt)}
                        {r.preferredStaff && ` · Wunsch: ${r.preferredStaff.fullName}`}
                      </p>
                      <ul className="mt-1 text-xs text-secondary dark:text-disabled space-y-0.5">
                        {slots.map((s, i) => (
                          <li key={i}>
                            {fmtDateTimeMedium(new Date(s.startsAt))} – {fmtDateTimeMedium(new Date(s.endsAt))}
                          </li>
                        ))}
                      </ul>
                      {r.status === 'ACCEPTED' && r.acceptedSlot && (
                        <p className="text-xs text-emerald-700 mt-1">
                          Bestätigt für: {fmtDateTimeMedium(new Date((r.acceptedSlot as { startsAt: string }).startsAt))}
                        </p>
                      )}
                      {r.status === 'REJECTED' && r.rejectionReason && (
                        <p className="text-xs text-red-700 mt-1">Grund: {r.rejectionReason}</p>
                      )}
                    </div>
                    {r.status === 'PENDING' && (
                      <CancelRequestButton id={r.id} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
