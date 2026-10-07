// Folgebefund F-08: Vor jedem Versandversuch prüft der Worker (und der
// manuelle Neuversand), ob die Mail noch gewollt ist. Je Anlass: noch gewollt
// → versenden; Vorgang erledigt, zurückgezogen oder abgesagt → verwerfen mit
// Begründung. Die Prüfung setzt den Tenant-Filter selbst.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkMailOutboxRelevanceTx,
  MAIL_OUTBOX_PURPOSES,
  type MailOutboxPurpose,
  type MailOutboxRelevanceReader,
} from '../outbox';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const RESOURCE = '33333333-3333-4333-8333-333333333333';

const RESOURCE_TYPE: Record<MailOutboxPurpose, string> = {
  'invoice-sent': 'invoice',
  'invoice-external': 'invoice',
  'handover-ready': 'client_handover',
  'request-opened': 'request',
  'request-staff-replied': 'request',
  'gwg-activated': 'gwg_check',
  'gwg-invite': 'gwg_onboarding_invite',
  'appointment-confirmed': 'appointment_request',
  'appointment-rejected': 'appointment_request',
  'form-sent': 'form_submission',
};

const MODEL: Record<string, keyof MailOutboxRelevanceReader> = {
  invoice: 'invoice',
  client_handover: 'clientHandover',
  request: 'request',
  gwg_check: 'gwgCheck',
  gwg_onboarding_invite: 'gwgOnboardingInvite',
  appointment_request: 'appointmentRequest',
  form_submission: 'formSubmission',
};

function reader() {
  const findFirst = Object.fromEntries(
    ['client', ...Object.values(MODEL)].map((name) => [name, vi.fn()]),
  ) as Record<string, ReturnType<typeof vi.fn>>;
  const db = Object.fromEntries(
    Object.entries(findFirst).map(([name, fn]) => [name, { findFirst: fn }]),
  ) as unknown as MailOutboxRelevanceReader;
  return { db, findFirst };
}

function row(purpose: MailOutboxPurpose) {
  return {
    tenantId: TENANT,
    clientId: CLIENT,
    purpose,
    resourceType: RESOURCE_TYPE[purpose],
    resourceId: RESOURCE,
  };
}

/** Berliner Wanduhrzeit, wie das Portal Wunschtermine speichert. */
const SLOT_START = '2026-10-20T10:00';
const SLOT_INSTANT = new Date('2026-10-20T08:00:00.000Z'); // CEST (UTC+2)

const WANTED_STATE: Record<MailOutboxPurpose, unknown> = {
  'invoice-sent': { status: 'SENT', sentAt: NOW },
  'invoice-external': { status: 'PAID', sentAt: NOW },
  'handover-ready': { status: 'READY' },
  'request-opened': { status: 'IN_PROGRESS' },
  'request-staff-replied': { status: 'CLOSED' },
  'gwg-activated': { status: 'VERIFIED', client: { allowActive: true } },
  'gwg-invite': { status: 'STARTED', expiresAt: new Date('2026-10-20T00:00:00.000Z') },
  'appointment-confirmed': {
    status: 'ACCEPTED',
    acceptedSlot: { startsAt: SLOT_START, endsAt: '2026-10-20T11:00' },
    acceptedAppointment: { status: 'CONFIRMED', startsAt: SLOT_INSTANT },
  },
  'appointment-rejected': { status: 'REJECTED' },
  'form-sent': { status: 'DRAFT' },
};

const OBSOLETE: Array<[MailOutboxPurpose, string, unknown, string]> = [
  ['invoice-sent', 'gelöscht', null, 'Die Rechnung existiert nicht mehr.'],
  [
    'invoice-external',
    'nie versendet storniert',
    { status: 'CANCELLED', sentAt: null },
    'Die Rechnung ist im Mandantenportal nicht sichtbar.',
  ],
  [
    'handover-ready',
    'abgeholt',
    { status: 'PICKED_UP' },
    'Die Unterlagen wurden bereits abgeholt.',
  ],
  [
    'handover-ready',
    'zurück in Bearbeitung',
    { status: 'IN_PROGRESS' },
    'Die Unterlagen sind nicht mehr abholbereit.',
  ],
  [
    'request-opened',
    'beantwortet',
    { status: 'RESPONDED' },
    'Die Anforderung wurde bereits beantwortet.',
  ],
  [
    'request-opened',
    'geschlossen',
    { status: 'CLOSED' },
    'Die Anforderung ist bereits abgeschlossen.',
  ],
  [
    'request-staff-replied',
    'storniert',
    { status: 'CANCELLED' },
    'Die Anforderung wurde storniert.',
  ],
  [
    'gwg-activated',
    'Prüfung abgelehnt',
    { status: 'REJECTED', client: { allowActive: false } },
    'Die GwG-Prüfung ist nicht mehr freigegeben.',
  ],
  [
    'gwg-activated',
    'Freischaltung zurückgenommen',
    { status: 'VERIFIED', client: { allowActive: false } },
    'Die Freischaltung wurde zurückgenommen.',
  ],
  [
    'gwg-invite',
    'zurückgezogen',
    { status: 'CANCELLED', expiresAt: new Date('2026-10-20T00:00:00.000Z') },
    'Die GwG-Einladung wurde zurückgezogen.',
  ],
  [
    'gwg-invite',
    'eingereicht',
    { status: 'SUBMITTED', expiresAt: new Date('2026-10-20T00:00:00.000Z') },
    'Die GwG-Einladung wurde bereits eingereicht.',
  ],
  [
    'gwg-invite',
    'abgelaufen (Frist überschritten)',
    { status: 'PENDING', expiresAt: NOW },
    'Die GwG-Einladung ist abgelaufen.',
  ],
  [
    'appointment-confirmed',
    'Termin abgesagt',
    {
      status: 'ACCEPTED',
      acceptedSlot: { startsAt: SLOT_START },
      acceptedAppointment: { status: 'CANCELLED', startsAt: SLOT_INSTANT },
    },
    'Der Termin wurde abgesagt.',
  ],
  [
    'appointment-confirmed',
    'Termin verschoben',
    {
      status: 'ACCEPTED',
      acceptedSlot: { startsAt: SLOT_START },
      acceptedAppointment: {
        status: 'CONFIRMED',
        startsAt: new Date('2026-10-20T09:00:00.000Z'),
      },
    },
    'Der Termin wurde seit der Bestätigung verschoben.',
  ],
  [
    'appointment-confirmed',
    'Termin begonnen',
    {
      status: 'ACCEPTED',
      acceptedSlot: { startsAt: '2026-10-07T12:00' },
      acceptedAppointment: { status: 'CONFIRMED', startsAt: NOW },
    },
    'Der Termin hat bereits begonnen.',
  ],
  [
    'appointment-confirmed',
    'Termin gelöscht',
    { status: 'ACCEPTED', acceptedSlot: null, acceptedAppointment: null },
    'Der bestätigte Termin existiert nicht mehr.',
  ],
  [
    'appointment-rejected',
    'vom Mandanten storniert',
    { status: 'CANCELLED' },
    'Die Terminanfrage ist nicht mehr abgelehnt.',
  ],
  ['form-sent', 'eingereicht', { status: 'SUBMITTED' }, 'Das Formular wurde bereits eingereicht.'],
];

let h: ReturnType<typeof reader>;

beforeEach(() => {
  h = reader();
  h.findFirst['client']!.mockResolvedValue({ anonymizedAt: null });
});

describe('checkMailOutboxRelevanceTx', () => {
  it('deckt jeden Anlass der Mail-Outbox ab', () => {
    expect(Object.keys(WANTED_STATE).sort()).toEqual([...MAIL_OUTBOX_PURPOSES].sort());
  });

  it.each([...MAIL_OUTBOX_PURPOSES])('lässt %s im aktiven Vorgang versenden', async (purpose) => {
    const model = MODEL[RESOURCE_TYPE[purpose]]!;
    h.findFirst[model]!.mockResolvedValue(WANTED_STATE[purpose]);

    await expect(checkMailOutboxRelevanceTx(h.db, row(purpose), NOW)).resolves.toEqual({
      wanted: true,
    });
    // Tenant-, Mandanten- und Vorgangsbindung (der Worker liest ohne RLS).
    expect(h.findFirst[model]).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RESOURCE, tenantId: TENANT, clientId: CLIENT } }),
    );
  });

  it.each(OBSOLETE)('verwirft %s (%s)', async (purpose, _label, state, reason) => {
    h.findFirst[MODEL[RESOURCE_TYPE[purpose]]!]!.mockResolvedValue(state);

    await expect(checkMailOutboxRelevanceTx(h.db, row(purpose), NOW)).resolves.toEqual({
      wanted: false,
      reason,
    });
  });

  it('verwirft jede Mail an einen anonymisierten Mandanten ohne Vorgangsabfrage', async () => {
    h.findFirst['client']!.mockResolvedValue({ anonymizedAt: new Date('2026-10-01') });

    await expect(checkMailOutboxRelevanceTx(h.db, row('invoice-sent'), NOW)).resolves.toEqual({
      wanted: false,
      reason: 'Der Mandant wurde anonymisiert.',
    });
    expect(h.findFirst['client']).toHaveBeenCalledWith({
      where: { id: CLIENT, tenantId: TENANT },
      select: { anonymizedAt: true },
    });
    expect(h.findFirst['invoice']).not.toHaveBeenCalled();
  });

  it('bleibt bei unbekanntem Anlass oder abweichendem Vorgangstyp beim Versand', async () => {
    await expect(
      checkMailOutboxRelevanceTx(h.db, { ...row('invoice-sent'), purpose: 'legacy-mail' }, NOW),
    ).resolves.toEqual({ wanted: true });
    await expect(
      checkMailOutboxRelevanceTx(h.db, { ...row('invoice-sent'), resourceType: 'request' }, NOW),
    ).resolves.toEqual({ wanted: true });
    expect(h.findFirst['invoice']).not.toHaveBeenCalled();
  });

  it('vergleicht verschobene Termine in Berliner Wanduhrzeit (Winterzeit)', async () => {
    h.findFirst['appointmentRequest']!.mockResolvedValue({
      status: 'ACCEPTED',
      acceptedSlot: { startsAt: '2026-11-03T09:30' },
      // 09:30 MEZ (UTC+1)
      acceptedAppointment: { status: 'PLANNED', startsAt: new Date('2026-11-03T08:30:00.000Z') },
    });

    await expect(
      checkMailOutboxRelevanceTx(h.db, row('appointment-confirmed'), NOW),
    ).resolves.toEqual({ wanted: true });
  });

  it('versendet eine Bestätigung mit unbekanntem Slot-Format weiter', async () => {
    h.findFirst['appointmentRequest']!.mockResolvedValue({
      status: 'ACCEPTED',
      acceptedSlot: { startsAt: 'morgen früh' },
      acceptedAppointment: { status: 'CONFIRMED', startsAt: SLOT_INSTANT },
    });

    await expect(
      checkMailOutboxRelevanceTx(h.db, row('appointment-confirmed'), NOW),
    ).resolves.toEqual({ wanted: true });
  });
});
