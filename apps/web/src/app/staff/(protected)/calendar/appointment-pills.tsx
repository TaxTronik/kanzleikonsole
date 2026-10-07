// =============================================================================
// Terminpillen eines Kalendertags (Review-Befund C1)
//
// Aktive Termine öffnen den Dialog zum Bearbeiten und Absagen. Abgesagte Termine
// verschwinden nicht mehr (früher: Löschen), sondern bleiben durchgestrichen und
// ohne Aktion sichtbar — hinter den aktiven, damit sie keine aktiven aus den
// Pillen eines Tages verdrängen.
// =============================================================================

import { berlinWallClock, fmtTimeShort } from '@/lib/fmt';
import type { AppointmentStaffOption } from './appointment-form-fields';
import { EditAppointmentDialog, type EditableAppointment } from './edit-appointment-dialog';

export interface CalendarAppointment {
  id: string;
  title: string;
  kind: EditableAppointment['kind'];
  status: EditableAppointment['status'] | 'CANCELLED';
  ownerStaffId: string;
  owner: { fullName: string };
  client: { id: string; name: string } | null;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  notes: string | null;
  fromRequestId: string | null;
}

/** Stabil: innerhalb beider Gruppen bleibt die Startzeit-Reihenfolge erhalten. */
export function sortCancelledLast<T extends { status: string }>(appointments: readonly T[]): T[] {
  return [...appointments].sort(
    (a, b) => Number(a.status === 'CANCELLED') - Number(b.status === 'CANCELLED'),
  );
}

export function editableAppointment(
  appointment: CalendarAppointment,
  status: EditableAppointment['status'],
): EditableAppointment {
  return {
    id: appointment.id,
    title: appointment.title,
    kind: appointment.kind,
    status,
    ownerStaffId: appointment.ownerStaffId,
    ownerName: appointment.owner.fullName,
    client: appointment.client
      ? { id: appointment.client.id, name: appointment.client.name }
      : null,
    startsAt: berlinWallClock(appointment.startsAt),
    endsAt: berlinWallClock(appointment.endsAt),
    location: appointment.location,
    notes: appointment.notes,
    fromRequest: appointment.fromRequestId !== null,
  };
}

export function AppointmentPills({
  appointments,
  staffOptions,
  limit,
}: {
  appointments: readonly CalendarAppointment[];
  staffOptions: readonly AppointmentStaffOption[];
  limit: number;
}) {
  return (
    <>
      {sortCancelledLast(appointments)
        .slice(0, limit)
        .map((appointment) => {
          const time = fmtTimeShort(appointment.startsAt);
          const label = `${time} – ${fmtTimeShort(appointment.endsAt)}: ${appointment.title}${appointment.client ? ' · ' + appointment.client.name : ''}`;
          if (appointment.status === 'CANCELLED') {
            return (
              <span
                key={appointment.id}
                className="cal-pill cal-pill-cancelled"
                title={`Abgesagt — ${label}`}
              >
                <span className="font-medium">Abgesagt</span>
                <s>
                  {' '}
                  · {time}
                  {appointment.client && ` · ${appointment.client.name}`} · {appointment.title}
                </s>
              </span>
            );
          }
          return (
            <EditAppointmentDialog
              key={appointment.id}
              appointment={editableAppointment(appointment, appointment.status)}
              staffOptions={staffOptions}
              label={`${label} — bearbeiten oder absagen`}
            >
              <span className="font-medium">{time}</span>
              {appointment.client && <span> · {appointment.client.name}</span>}
              <span className="opacity-70"> · {appointment.title}</span>
            </EditAppointmentDialog>
          );
        })}
    </>
  );
}
