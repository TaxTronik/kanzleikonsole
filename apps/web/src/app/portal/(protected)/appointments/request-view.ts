// =============================================================================
// Eigene Terminanfrage im Portal: Stand des daraus entstandenen Termins
// (Review-Befund C1)
//
// Seit die Kanzlei angenommene Termine verschieben und absagen kann, nennt eine
// angenommene Anfrage den heutigen Beginn ihres Termins statt des ursprünglich
// bestätigten Wunschtermins, und ein abgesagter Termin steht nicht länger als
// „Bestätigt" da (die Liste „Bestätigte Termine" blendet ihn bereits aus). Eine
// Benachrichtigung des Mandanten ist damit nicht verbunden.
// =============================================================================

import { berlinWallClockToUtc } from '@/lib/fmt';

export type PortalRequestBadge =
  | 'PENDING'
  | 'ACCEPTED'
  | 'APPOINTMENT_CANCELLED'
  | 'REJECTED'
  | 'CANCELLED';

export interface PortalRequestView {
  badge: PortalRequestBadge;
  /** Beginn des bestätigten Termins; nur bei einer angenommenen, nicht abgesagten Anfrage. */
  confirmedFor: Date | null;
}

function slotStart(slot: unknown): Date | null {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
  const startsAt = (slot as Record<string, unknown>)['startsAt'];
  return typeof startsAt === 'string' ? berlinWallClockToUtc(startsAt.slice(0, 16)) : null;
}

export function portalRequestView(request: {
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  acceptedSlot: unknown;
  acceptedAppointment: { status: string; startsAt: Date } | null;
}): PortalRequestView {
  if (request.status !== 'ACCEPTED') return { badge: request.status, confirmedFor: null };
  const appointment = request.acceptedAppointment;
  if (appointment?.status === 'CANCELLED') {
    return { badge: 'APPOINTMENT_CANCELLED', confirmedFor: null };
  }
  return {
    badge: 'ACCEPTED',
    confirmedFor: appointment ? appointment.startsAt : slotStart(request.acceptedSlot),
  };
}
