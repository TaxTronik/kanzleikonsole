// Folgebefund F-08: Vor jedem Versandversuch prüft der Worker (und der
// manuelle Neuversand), ob die Mail noch gewollt ist. Je Anlass: noch gewollt
// → versenden; Vorgang erledigt, zurückgezogen oder abgesagt → verwerfen mit
// Begründung. Die Prüfung setzt den Tenant-Filter selbst.
// TCMS Stufe 4: Mitteilungen des Tax-CMS fail-closed (Gültigkeitsende,
// bestätigter Empfänger dieses Mandanten mit unveränderter Adresse).
//
// Fachkatalog: MAIL-OUTBOX-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkMailOutboxRelevanceTx,
  MAIL_OUTBOX_PURPOSES,
  type MailOutboxPurpose,
  type MailOutboxRelevanceReader,
} from '../outbox';
import { istTcmsMailAnlass, TCMS_MAIL_ANLAESSE } from '../tcms-vorlagen';

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
  'appointment-changed': 'appointment',
  'appointment-cancelled': 'appointment',
  'tcms-freigabe-angefordert': 'tcms_nachricht',
  'tcms-freigabe-code': 'tcms_nachricht',
  'tcms-freigabe-neu-adressiert': 'tcms_nachricht',
};

/** Anlässe mit Vorgangsprüfung über die Vorgangs-ID (ohne TCMS-Mitteilungen). */
const VORGANG_ANLAESSE = MAIL_OUTBOX_PURPOSES.filter((purpose) => !istTcmsMailAnlass(purpose));

const MODEL: Record<string, keyof MailOutboxRelevanceReader> = {
  invoice: 'invoice',
  client_handover: 'clientHandover',
  request: 'request',
  gwg_check: 'gwgCheck',
  gwg_onboarding_invite: 'gwgOnboardingInvite',
  appointment_request: 'appointmentRequest',
  appointment: 'appointment',
  form_submission: 'formSubmission',
  tcms_nachricht: 'clientContact',
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

function row(purpose: MailOutboxPurpose, payload?: unknown) {
  return {
    tenantId: TENANT,
    clientId: CLIENT,
    purpose,
    resourceType: RESOURCE_TYPE[purpose],
    resourceId: RESOURCE,
    ...(payload === undefined ? {} : { payload }),
  };
}

/** Bestätigter Kontakt eines aktiven Mandats (TCMS-Mitteilungen). */
function TCMS_KONTAKT(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    email: 'Jana.Weller@talwind.example',
    lastLoginAt: new Date('2026-10-01T08:00:00.000Z'),
    client: { allowActive: true, mandateEndedAt: null },
    ...overrides,
  };
}
const KONTAKT = '44444444-4444-4444-8444-444444444444';

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
  'appointment-changed': {
    status: 'CONFIRMED',
    startsAt: SLOT_INSTANT,
    endsAt: new Date('2026-10-20T09:00:00.000Z'),
    title: 'Jahresgespräch',
    location: 'Büro',
  },
  'appointment-cancelled': { status: 'CANCELLED', startsAt: SLOT_INSTANT },
  'tcms-freigabe-angefordert': TCMS_KONTAKT(),
  'tcms-freigabe-code': TCMS_KONTAKT(),
  'tcms-freigabe-neu-adressiert': TCMS_KONTAKT(),
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
  [
    'appointment-changed',
    'Termin gelöscht oder anderem Mandanten zugeordnet',
    null,
    'Der Termin existiert für diesen Mandanten nicht mehr.',
  ],
  [
    'appointment-changed',
    'inzwischen abgesagt',
    { status: 'CANCELLED', startsAt: SLOT_INSTANT },
    'Der Termin wurde inzwischen abgesagt.',
  ],
  [
    'appointment-changed',
    'erledigt',
    { status: 'DONE', startsAt: SLOT_INSTANT },
    'Der Termin ist bereits erledigt.',
  ],
  [
    'appointment-changed',
    'begonnen',
    { status: 'CONFIRMED', startsAt: NOW },
    'Der Termin hat bereits begonnen.',
  ],
  [
    'appointment-cancelled',
    'nicht abgesagt',
    { status: 'CONFIRMED', startsAt: SLOT_INSTANT },
    'Der Termin ist nicht abgesagt.',
  ],
  [
    'appointment-cancelled',
    'begonnen',
    { status: 'CANCELLED', startsAt: NOW },
    'Der Termin hat bereits begonnen.',
  ],
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

  it.each(VORGANG_ANLAESSE)('lässt %s im aktiven Vorgang versenden', async (purpose) => {
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

  describe('Terminänderung (Welle 15): nur der angekündigte, aktuelle Stand', () => {
    const current = WANTED_STATE['appointment-changed'] as {
      startsAt: Date;
      endsAt: Date;
      title: string;
      location: string | null;
    };
    const announced = (overrides: Record<string, unknown> = {}) => ({
      v: 1,
      slug: 'appointment-changed',
      vars: {},
      relevance: {
        appointment: {
          startsAt: current.startsAt.toISOString(),
          endsAt: current.endsAt.toISOString(),
          title: current.title,
          location: current.location,
          ...overrides,
        },
      },
    });

    beforeEach(() => {
      h.findFirst['appointment']!.mockResolvedValue(current);
    });

    it('versendet, solange Zeit, Titel und Ort dem angekündigten Stand entsprechen', async () => {
      await expect(
        checkMailOutboxRelevanceTx(h.db, row('appointment-changed', announced()), NOW),
      ).resolves.toEqual({ wanted: true });
      expect(h.findFirst['appointment']).toHaveBeenCalledWith({
        where: { id: RESOURCE, tenantId: TENANT, clientId: CLIENT },
        select: { status: true, startsAt: true, endsAt: true, title: true, location: true },
      });
    });

    it.each([
      ['Beginn', { startsAt: '2026-10-20T07:00:00.000Z' }],
      ['Ende', { endsAt: '2026-10-20T10:00:00.000Z' }],
      ['Titel', { title: 'Vorgespräch' }],
      ['Ort', { location: null }],
    ])('verwirft eine überholte Änderungsmail (%s seitdem geändert)', async (_field, changed) => {
      await expect(
        checkMailOutboxRelevanceTx(h.db, row('appointment-changed', announced(changed)), NOW),
      ).resolves.toEqual({ wanted: false, reason: 'Der Termin wurde seitdem erneut geändert.' });
    });

    it('prüft ohne angekündigten Stand nur den Status (konservativ)', async () => {
      await expect(
        checkMailOutboxRelevanceTx(
          h.db,
          row('appointment-changed', { v: 1, slug: 'x', vars: {}, relevance: { other: 1 } }),
          NOW,
        ),
      ).resolves.toEqual({ wanted: true });
      await expect(
        checkMailOutboxRelevanceTx(h.db, row('appointment-changed', {}), NOW),
      ).resolves.toEqual({ wanted: true });
    });
  });
});

describe('Mitteilungen des Tax-CMS (TCMS Stufe 4, fail-closed)', () => {
  const BIS = '2026-10-14T10:00:00.000Z';
  const payload = (
    relevance: unknown = { bis: BIS, kontaktId: KONTAKT },
    to = 'jana.weller@talwind.example ',
  ) => ({
    v: 1,
    slug: 'tcms-freigabe-code',
    to,
    vars: {},
    relevance,
  });

  beforeEach(() => {
    h.findFirst['clientContact']!.mockResolvedValue(TCMS_KONTAKT());
  });

  it.each([...TCMS_MAIL_ANLAESSE])(
    'versendet %s bis zum Gültigkeitsende an den bestätigten Kontakt dieses Mandanten',
    async (purpose) => {
      await expect(checkMailOutboxRelevanceTx(h.db, row(purpose, payload()), NOW)).resolves.toEqual(
        {
          wanted: true,
        },
      );
      expect(h.findFirst['clientContact']).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: KONTAKT, tenantId: TENANT, clientId: CLIENT } }),
      );
    },
  );

  it.each([
    [
      'Gültigkeitsende erreicht',
      payload({ bis: NOW.toISOString(), kontaktId: KONTAKT }),
      'Die Mitteilung des Tax-CMS ist abgelaufen.',
    ],
    [
      'ohne Gültigkeitsende',
      payload({ kontaktId: KONTAKT }),
      'Die Mitteilung des Tax-CMS hat kein Gültigkeitsende.',
    ],
    [
      'Gültigkeitsende unlesbar',
      payload({ bis: 'bald', kontaktId: KONTAKT }),
      'Die Mitteilung des Tax-CMS hat kein Gültigkeitsende.',
    ],
    ['ohne Payload', undefined, 'Die Mitteilung des Tax-CMS hat kein Gültigkeitsende.'],
    ['ohne Kontakt', payload({ bis: BIS }), 'Der Empfänger der Mitteilung ist nicht bestimmt.'],
    [
      'ohne Adresse',
      { v: 1, slug: 'x', vars: {}, relevance: { bis: BIS, kontaktId: KONTAKT } },
      'Der Empfänger der Mitteilung ist nicht bestimmt.',
    ],
  ])('verwirft ohne Abfrage: %s', async (_label, p, reason) => {
    await expect(
      checkMailOutboxRelevanceTx(h.db, row('tcms-freigabe-code', p), NOW),
    ).resolves.toEqual({ wanted: false, reason });
    expect(h.findFirst['clientContact']).not.toHaveBeenCalled();
  });

  it.each([
    [
      'anderem Mandanten oder gelöscht',
      null,
      'Der Empfänger gehört nicht (mehr) zu diesem Mandanten.',
    ],
    ['inaktiv', TCMS_KONTAKT({ active: false }), 'Der Empfänger ist nicht mehr aktiv.'],
    [
      'nie angemeldet',
      TCMS_KONTAKT({ lastLoginAt: null }),
      'Die Adresse des Empfängers ist nicht bestätigt.',
    ],
    [
      'Mandat beendet',
      TCMS_KONTAKT({ client: { allowActive: true, mandateEndedAt: NOW } }),
      'Das Mandat ist nicht mehr aktiv.',
    ],
    [
      'Mandant gesperrt',
      TCMS_KONTAKT({ client: { allowActive: false, mandateEndedAt: null } }),
      'Das Mandat ist nicht mehr aktiv.',
    ],
    [
      'Adresse geändert',
      TCMS_KONTAKT({ email: 'neu@talwind.example' }),
      'Die E-Mail-Adresse des Empfängers hat sich geändert.',
    ],
  ])('verwirft, wenn der Empfänger %s ist', async (_label, kontakt, reason) => {
    h.findFirst['clientContact']!.mockResolvedValue(kontakt);
    await expect(
      checkMailOutboxRelevanceTx(h.db, row('tcms-freigabe-angefordert', payload()), NOW),
    ).resolves.toEqual({ wanted: false, reason });
  });

  it('verwirft eine TCMS-Mitteilung mit fremdem Vorgangstyp (kein Rückfall auf „gewollt“)', async () => {
    await expect(
      checkMailOutboxRelevanceTx(
        h.db,
        { ...row('tcms-freigabe-code', payload()), resourceType: 'request' },
        NOW,
      ),
    ).resolves.toEqual({
      wanted: false,
      reason: 'Der Auftrag gehört zu keiner Mitteilung des Tax-CMS.',
    });
  });
});
