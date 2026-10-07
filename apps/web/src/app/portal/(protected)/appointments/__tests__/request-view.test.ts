// Review-Befund C1: Die eigene Terminanfrage im Portal zeigt den Stand des
// daraus entstandenen Termins, seit die Kanzlei Termine verschiebt und absagt.

import { describe, expect, it } from 'vitest';
import { portalRequestView } from '../request-view';

const SLOT = { startsAt: '2026-10-20T10:00', endsAt: '2026-10-20T11:00' };

describe('portalRequestView', () => {
  it('nennt den Beginn des bestätigten Termins — nach einer Verschiebung den neuen', () => {
    expect(
      portalRequestView({
        status: 'ACCEPTED',
        acceptedSlot: SLOT,
        acceptedAppointment: {
          status: 'CONFIRMED',
          startsAt: new Date('2026-10-21T12:30:00.000Z'),
        },
      }),
    ).toEqual({ badge: 'ACCEPTED', confirmedFor: new Date('2026-10-21T12:30:00.000Z') });
  });

  it('zeigt einen abgesagten Termin nicht länger als bestätigt', () => {
    expect(
      portalRequestView({
        status: 'ACCEPTED',
        acceptedSlot: SLOT,
        acceptedAppointment: { status: 'CANCELLED', startsAt: new Date('2026-10-20T08:00:00Z') },
      }),
    ).toEqual({ badge: 'APPOINTMENT_CANCELLED', confirmedFor: null });
  });

  it('fällt ohne verknüpften Termin auf den bestätigten Wunschtermin (Berlin-Zeit) zurück', () => {
    expect(
      portalRequestView({ status: 'ACCEPTED', acceptedSlot: SLOT, acceptedAppointment: null }),
    ).toEqual({ badge: 'ACCEPTED', confirmedFor: new Date('2026-10-20T08:00:00.000Z') });
    expect(
      portalRequestView({ status: 'ACCEPTED', acceptedSlot: null, acceptedAppointment: null }),
    ).toEqual({ badge: 'ACCEPTED', confirmedFor: null });
  });

  it.each(['PENDING', 'REJECTED', 'CANCELLED'] as const)(
    'übernimmt den Anfragestatus %s ohne Terminzeit',
    (status) => {
      expect(portalRequestView({ status, acceptedSlot: SLOT, acceptedAppointment: null })).toEqual({
        badge: status,
        confirmedFor: null,
      });
    },
  );
});
