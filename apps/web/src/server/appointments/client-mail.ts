// =============================================================================
// Mandanten-Mail bei Terminänderung oder -absage (Welle 15, Entscheidung
// „Checkbox im Dialog“)
//
// Bearbeiten- und Absagen-Dialog des Kanzleikalenders bieten „Mandant per
// E-Mail informieren“ an. Empfänger nach denselben Regeln wie die
// Entscheidungsmail zu Terminanfragen (calendar/actions.ts): ein Kontakt muss
// aktiv sein und Benachrichtigungen eingeschaltet haben.
//   - Termin aus einer Terminanfrage dieses Mandanten: der anfragende Kontakt.
//   - sonst: jeder solche Kontakt des Mandanten (je Adresse ein Auftrag).
// Ohne Mandantenbezug, bei anonymisiertem Mandanten oder ohne erreichbaren
// Kontakt gibt es keine Mail; der Dialog nennt den Grund.
//
// Die Mails laufen über die Mail-Outbox (MAIL-OUTBOX-001) mit eigenem Anlass je
// Fall. Inhalt wie bei den übrigen Termin-Mails: Titel, Zeit und Ort bzw. die
// Absage, nie die internen Notizen. Die Änderungsmail trägt den angekündigten
// Stand (payload.relevance); der Worker verwirft sie, wenn der Termin vor dem
// Versand erneut geändert oder abgesagt wurde. Alle Aufträge einer Auslösung
// teilen created_at, damit der Zustellstatus nur die jüngste zeigt.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { berlinYmd, fmtDateTimeMedium, fmtTimeShort } from '@/lib/fmt';
import { enqueueDirectMailTx, type OutboxDirectMail } from '@/server/mail/outbox';

export type AppointmentClientMailPurpose = 'appointment-changed' | 'appointment-cancelled';

export interface AppointmentMailRecipient {
  contactId: string;
  fullName: string;
  email: string;
}

/** Was der Dialog zur Checkbox braucht: Empfänger oder der Grund, warum es keine gibt. */
export interface AppointmentClientMailOption {
  recipients: AppointmentMailRecipient[];
  unavailableReason: string | null;
}

export const APPOINTMENT_MAIL_UNAVAILABLE = {
  noClient: 'Der Termin hat keinen Mandantenbezug.',
  anonymized: 'Der Mandant ist anonymisiert.',
  requestContact:
    'Der anfragende Kontakt ist nicht mehr vorhanden, inaktiv oder hat keine Benachrichtigungen aktiviert.',
  noContact:
    'Für den Mandanten ist kein aktiver Kontakt mit eingeschalteten Benachrichtigungen hinterlegt.',
} as const;

interface ContactCandidate {
  id: string;
  fullName: string;
  email: string;
  active: boolean;
  notificationsEnabled: boolean;
}

export interface AppointmentRecipientSource {
  clientId: string | null;
  clientAnonymized: boolean;
  /** Der Termin stammt aus einer Terminanfrage desselben Mandanten. */
  fromRequest: boolean;
  /** Anfragender Kontakt dieser Terminanfrage (null: nicht mehr vorhanden). */
  requestContact: ContactCandidate | null;
  clientContacts: readonly ContactCandidate[];
}

/** Regel der Entscheidungsmail: aktiver Kontakt mit Benachrichtigungen. */
function reachable(contact: ContactCandidate): boolean {
  return contact.active && contact.notificationsEnabled && contact.email.trim() !== '';
}

function recipient(contact: ContactCandidate): AppointmentMailRecipient {
  return { contactId: contact.id, fullName: contact.fullName, email: contact.email };
}

function unavailable(reason: string): AppointmentClientMailOption {
  return { recipients: [], unavailableReason: reason };
}

export function appointmentMailRecipients(
  source: AppointmentRecipientSource,
): AppointmentClientMailOption {
  if (!source.clientId) return unavailable(APPOINTMENT_MAIL_UNAVAILABLE.noClient);
  if (source.clientAnonymized) return unavailable(APPOINTMENT_MAIL_UNAVAILABLE.anonymized);
  if (source.fromRequest) {
    const contact = source.requestContact;
    return contact && reachable(contact)
      ? { recipients: [recipient(contact)], unavailableReason: null }
      : unavailable(APPOINTMENT_MAIL_UNAVAILABLE.requestContact);
  }
  const recipients = source.clientContacts.filter(reachable).map(recipient);
  return recipients.length > 0
    ? { recipients, unavailableReason: null }
    : unavailable(APPOINTMENT_MAIL_UNAVAILABLE.noContact);
}

const CONTACT_SELECT = {
  id: true,
  clientId: true,
  fullName: true,
  email: true,
  active: true,
  notificationsEnabled: true,
} as const;

interface AppointmentRecipientRef {
  id: string;
  clientId: string | null;
  fromRequestId: string | null;
}

/**
 * Empfängeroptionen mehrerer Termine mit drei Abfragen (Kalendermonat). Läuft
 * in der Tenant-Transaktion der Seite bzw. Action (RLS).
 */
export async function loadAppointmentMailOptionsTx(
  tx: TxClient,
  appointments: readonly AppointmentRecipientRef[],
): Promise<Map<string, AppointmentClientMailOption>> {
  const clientIds = [...new Set(appointments.flatMap((a) => (a.clientId ? [a.clientId] : [])))];
  const requestIds = [
    ...new Set(appointments.flatMap((a) => (a.fromRequestId ? [a.fromRequestId] : []))),
  ];
  const [clients, contacts, requests] = await Promise.all([
    clientIds.length > 0
      ? tx.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, anonymizedAt: true },
        })
      : Promise.resolve([]),
    clientIds.length > 0
      ? tx.clientContact.findMany({
          where: { clientId: { in: clientIds } },
          orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
          select: CONTACT_SELECT,
        })
      : Promise.resolve([]),
    requestIds.length > 0
      ? tx.appointmentRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, clientId: true, createdByContactRel: { select: CONTACT_SELECT } },
        })
      : Promise.resolve([]),
  ]);
  const anonymized = new Map(clients.map((c) => [c.id, c.anonymizedAt !== null]));
  const requestById = new Map(requests.map((r) => [r.id, r]));
  const result = new Map<string, AppointmentClientMailOption>();
  for (const appointment of appointments) {
    const request = appointment.fromRequestId
      ? requestById.get(appointment.fromRequestId)
      : undefined;
    // Ein inzwischen einem anderen Mandanten zugeordneter Termin informiert
    // dessen Kontakte, nicht den Anfragenden des alten Mandanten.
    const fromRequest = Boolean(request && request.clientId === appointment.clientId);
    result.set(
      appointment.id,
      appointmentMailRecipients({
        clientId: appointment.clientId,
        clientAnonymized: appointment.clientId
          ? (anonymized.get(appointment.clientId) ?? false)
          : false,
        fromRequest,
        requestContact: fromRequest ? (request?.createdByContactRel ?? null) : null,
        clientContacts: contacts.filter((c) => c.clientId === appointment.clientId),
      }),
    );
  }
  return result;
}

/** Empfängeroption eines Termins (Action). */
export async function loadAppointmentMailOptionTx(
  tx: TxClient,
  appointment: AppointmentRecipientRef,
): Promise<AppointmentClientMailOption> {
  const options = await loadAppointmentMailOptionsTx(tx, [appointment]);
  return options.get(appointment.id)!;
}

export interface AppointmentMailState {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
}

/** Ende als Uhrzeit, wenn der Termin am selben Berliner Tag endet. */
function fmtEnd(startsAt: Date, endsAt: Date): string {
  return berlinYmd(startsAt) === berlinYmd(endsAt)
    ? fmtTimeShort(endsAt)
    : fmtDateTimeMedium(endsAt);
}

const SIGNATURE = '\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei';

/** Ersatztexte, falls die Kanzlei die System-Vorlage gelöscht oder deaktiviert hat. */
export const APPOINTMENT_MAIL_FALLBACK: Readonly<
  Record<AppointmentClientMailPurpose, { subject: string; bodyMd: string }>
> = {
  'appointment-changed': {
    subject: 'Terminänderung: {{appointment.title}}',
    bodyMd: `Sehr geehrte/r {{contact.fullName}},\n\nIhr Termin wurde geändert. Es gilt jetzt:\n\n**{{appointment.title}}**\n{{appointment.startsAt}} bis {{appointment.endsAt}}\n{{appointment.location}}${SIGNATURE}`,
  },
  'appointment-cancelled': {
    subject: 'Terminabsage: {{appointment.title}}',
    bodyMd: `Sehr geehrte/r {{contact.fullName}},\n\nleider müssen wir den folgenden Termin absagen:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}\n\nFür einen neuen Termin melden Sie sich bitte bei uns oder nutzen Sie das Mandantenportal.${SIGNATURE}`,
  },
};

function appointmentMail(
  purpose: AppointmentClientMailPurpose,
  appointment: AppointmentMailState,
  contact: AppointmentMailRecipient,
): Omit<OutboxDirectMail, 'to'> {
  return {
    slug: purpose,
    vars: {
      contact: { fullName: contact.fullName, email: contact.email },
      // Bewusst ohne interne Notizen.
      appointment: {
        title: appointment.title,
        startsAt: fmtDateTimeMedium(appointment.startsAt),
        endsAt: fmtEnd(appointment.startsAt, appointment.endsAt),
        location: appointment.location ?? '',
      },
    },
    fallback: APPOINTMENT_MAIL_FALLBACK[purpose],
    ...(purpose === 'appointment-changed'
      ? {
          relevance: {
            appointment: {
              startsAt: appointment.startsAt.toISOString(),
              endsAt: appointment.endsAt.toISOString(),
              title: appointment.title,
              location: appointment.location,
            },
          },
        }
      : {}),
  };
}

/**
 * Legt je Empfänger einen Versandauftrag im Commit der Termin-Action an (alle
 * mit demselben created_at). Liefert die Zahl der Aufträge.
 */
export async function enqueueAppointmentClientMailTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    purpose: AppointmentClientMailPurpose;
    appointment: AppointmentMailState;
    recipients: readonly AppointmentMailRecipient[];
    now: Date;
  },
): Promise<number> {
  for (const contact of input.recipients) {
    await enqueueDirectMailTx(
      tx,
      {
        tenantId: input.tenantId,
        clientId: input.clientId,
        purpose: input.purpose,
        resource: { type: 'appointment', id: input.appointment.id },
        staffHref: '/staff/calendar',
        createdAt: input.now,
      },
      { ...appointmentMail(input.purpose, input.appointment, contact), to: contact.email },
    );
  }
  return input.recipients.length;
}
