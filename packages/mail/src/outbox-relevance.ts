// =============================================================================
// Mail-Outbox: Ist die Mail vor dem Versand noch gewollt? (Folgebefund F-08)
//
// Zwischen fachlichem Commit und Versand können Minuten (Backoff) oder — bei
// einem manuellen Neuversand — Tage liegen. Inzwischen kann der Vorgang
// erledigt, zurückgezogen oder abgesagt sein: eine Einladung wurde storniert,
// der Termin abgesagt, die Anforderung geschlossen. Vor jedem Versandversuch
// prüft der Worker deshalb je Anlass den aktuellen Zustand des Vorgangs; der
// manuelle Neuversand der Web-App nutzt dieselbe Prüfung. Eine nicht mehr
// gewollte Mail endet als SKIPPED mit Begründung statt versendet zu werden.
//
// Die Prüfung setzt den Tenant-Filter selbst (der Worker liest als Owner ohne
// RLS) und ist bewusst konservativ: Sie verhindert nur Mails, deren Anlass
// erkennbar entfallen ist oder deren Inhalt nicht mehr stimmt. Ein unbekannter
// Anlass bleibt gewollt (bisheriges Verhalten).
// =============================================================================

import type { Prisma } from '@prisma/client';
import { MAIL_OUTBOX_PURPOSES, type MailOutboxPurpose } from './outbox-purposes';

export type MailOutboxRelevance = { wanted: true } | { wanted: false; reason: string };

/** Lesezugriff auf die Vorgänge aller Anlässe (Owner-Client oder Tenant-Transaktion). */
export type MailOutboxRelevanceReader = Pick<
  Prisma.TransactionClient,
  | 'client'
  | 'invoice'
  | 'clientHandover'
  | 'request'
  | 'gwgCheck'
  | 'gwgOnboardingInvite'
  | 'appointmentRequest'
  | 'formSubmission'
>;

export interface MailOutboxRelevanceRow {
  tenantId: string;
  clientId: string;
  purpose: string;
  resourceType: string;
  resourceId: string;
}

interface ResourceRef {
  tenantId: string;
  clientId: string;
  id: string;
}

type Check = (
  db: MailOutboxRelevanceReader,
  ref: ResourceRef,
  now: Date,
) => Promise<MailOutboxRelevance>;

const WANTED: MailOutboxRelevance = { wanted: true };

function obsolete(reason: string): MailOutboxRelevance {
  return { wanted: false, reason };
}

function scope(ref: ResourceRef) {
  return { id: ref.id, tenantId: ref.tenantId, clientId: ref.clientId };
}

/** Rechnungsmail: gewollt, solange die Rechnung im Mandantenportal sichtbar ist. */
const invoiceVisible: Check = async (db, ref) => {
  const invoice = await db.invoice.findFirst({
    where: scope(ref),
    select: { status: true, sentAt: true },
  });
  if (!invoice) return obsolete('Die Rechnung existiert nicht mehr.');
  // Wie portalInvoiceVisibilityWhere: Entwürfe und nie versendete Storni sind unsichtbar.
  if (invoice.status === 'DRAFT' || (invoice.status === 'CANCELLED' && !invoice.sentAt)) {
    return obsolete('Die Rechnung ist im Mandantenportal nicht sichtbar.');
  }
  return WANTED;
};

const handoverReady: Check = async (db, ref) => {
  const handover = await db.clientHandover.findFirst({
    where: scope(ref),
    select: { status: true },
  });
  if (!handover) return obsolete('Die Anlieferung existiert nicht mehr.');
  if (handover.status === 'PICKED_UP') return obsolete('Die Unterlagen wurden bereits abgeholt.');
  if (handover.status !== 'READY') return obsolete('Die Unterlagen sind nicht mehr abholbereit.');
  return WANTED;
};

const REQUEST_NOT_OPEN: Readonly<Record<string, string>> = {
  RESPONDED: 'Die Anforderung wurde bereits beantwortet.',
  CLOSED: 'Die Anforderung ist bereits abgeschlossen.',
  CANCELLED: 'Die Anforderung wurde storniert.',
};

/** Neue Anforderung: nur solange sie offen ist (wie TAX-DEADLINE-AUTOREQUEST-001). */
const requestOpen: Check = async (db, ref) => {
  const request = await db.request.findFirst({ where: scope(ref), select: { status: true } });
  if (!request) return obsolete('Die Anforderung existiert nicht mehr.');
  const closed = REQUEST_NOT_OPEN[request.status];
  return closed ? obsolete(closed) : WANTED;
};

/** Kanzlei-Antwort: bleibt auch nach Abschluss sichtbar; nur eine Stornierung entwertet sie. */
const requestNotCancelled: Check = async (db, ref) => {
  const request = await db.request.findFirst({ where: scope(ref), select: { status: true } });
  if (!request) return obsolete('Die Anforderung existiert nicht mehr.');
  if (request.status === 'CANCELLED') return obsolete('Die Anforderung wurde storniert.');
  return WANTED;
};

const gwgActivationEffective: Check = async (db, ref) => {
  const check = await db.gwgCheck.findFirst({
    where: scope(ref),
    select: { status: true, client: { select: { allowActive: true } } },
  });
  if (!check) return obsolete('Die GwG-Prüfung existiert nicht mehr.');
  if (check.status !== 'VERIFIED') return obsolete('Die GwG-Prüfung ist nicht mehr freigegeben.');
  if (!check.client.allowActive) return obsolete('Die Freischaltung wurde zurückgenommen.');
  return WANTED;
};

const gwgInviteUsable: Check = async (db, ref, now) => {
  const invite = await db.gwgOnboardingInvite.findFirst({
    where: scope(ref),
    select: { status: true, expiresAt: true },
  });
  if (!invite) return obsolete('Die GwG-Einladung existiert nicht mehr.');
  if (invite.status === 'CANCELLED') return obsolete('Die GwG-Einladung wurde zurückgezogen.');
  if (invite.status === 'SUBMITTED')
    return obsolete('Die GwG-Einladung wurde bereits eingereicht.');
  if (invite.status === 'EXPIRED' || invite.expiresAt.getTime() <= now.getTime()) {
    return obsolete('Die GwG-Einladung ist abgelaufen.');
  }
  return WANTED;
};

const berlinMinuteFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Instant als Berliner Wanduhrzeit `YYYY-MM-DDTHH:MM` (Format der Wunschtermine). */
function berlinWallClockMinute(instant: Date): string {
  const parts = Object.fromEntries(
    berlinMinuteFormat.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}

/** Beginn des angenommenen Wunschtermins; null, wenn das Format unbekannt ist. */
function acceptedSlotStart(slot: Prisma.JsonValue | null): string | null {
  if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) return null;
  const startsAt = slot['startsAt'];
  return typeof startsAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startsAt)
    ? startsAt.slice(0, 16)
    : null;
}

/**
 * Terminbestätigung: Die Mail nennt Titel und Beginn des angenommenen
 * Wunschtermins. Ein abgesagter, erledigter, bereits begonnener oder seitdem
 * verschobener Termin macht sie überholt (eine Änderungsmail gibt es nicht).
 */
const appointmentStillConfirmed: Check = async (db, ref, now) => {
  const request = await db.appointmentRequest.findFirst({
    where: scope(ref),
    select: {
      status: true,
      acceptedSlot: true,
      acceptedAppointment: { select: { status: true, startsAt: true } },
    },
  });
  if (!request) return obsolete('Die Terminanfrage existiert nicht mehr.');
  if (request.status !== 'ACCEPTED')
    return obsolete('Die Terminanfrage ist nicht mehr angenommen.');
  const appointment = request.acceptedAppointment;
  if (!appointment) return obsolete('Der bestätigte Termin existiert nicht mehr.');
  if (appointment.status === 'CANCELLED') return obsolete('Der Termin wurde abgesagt.');
  if (appointment.status === 'DONE') return obsolete('Der Termin ist bereits erledigt.');
  if (appointment.startsAt.getTime() <= now.getTime()) {
    return obsolete('Der Termin hat bereits begonnen.');
  }
  const slotStart = acceptedSlotStart(request.acceptedSlot);
  if (slotStart !== null && slotStart !== berlinWallClockMinute(appointment.startsAt)) {
    return obsolete('Der Termin wurde seit der Bestätigung verschoben.');
  }
  return WANTED;
};

const appointmentStillRejected: Check = async (db, ref) => {
  const request = await db.appointmentRequest.findFirst({
    where: scope(ref),
    select: { status: true },
  });
  if (!request) return obsolete('Die Terminanfrage existiert nicht mehr.');
  if (request.status !== 'REJECTED') return obsolete('Die Terminanfrage ist nicht mehr abgelehnt.');
  return WANTED;
};

const formStillOpen: Check = async (db, ref) => {
  const submission = await db.formSubmission.findFirst({
    where: scope(ref),
    select: { status: true },
  });
  if (!submission) return obsolete('Das Formular existiert nicht mehr.');
  if (submission.status === 'SUBMITTED' || submission.status === 'REVIEWED') {
    return obsolete('Das Formular wurde bereits eingereicht.');
  }
  return WANTED;
};

/** Je Anlass der erwartete Vorgangstyp und seine Prüfung. */
const CHECKS: Readonly<Record<MailOutboxPurpose, { resourceType: string; check: Check }>> = {
  'invoice-sent': { resourceType: 'invoice', check: invoiceVisible },
  'invoice-external': { resourceType: 'invoice', check: invoiceVisible },
  'handover-ready': { resourceType: 'client_handover', check: handoverReady },
  'request-opened': { resourceType: 'request', check: requestOpen },
  'request-staff-replied': { resourceType: 'request', check: requestNotCancelled },
  'gwg-activated': { resourceType: 'gwg_check', check: gwgActivationEffective },
  'gwg-invite': { resourceType: 'gwg_onboarding_invite', check: gwgInviteUsable },
  'appointment-confirmed': {
    resourceType: 'appointment_request',
    check: appointmentStillConfirmed,
  },
  'appointment-rejected': { resourceType: 'appointment_request', check: appointmentStillRejected },
  'form-sent': { resourceType: 'form_submission', check: formStillOpen },
};

function isKnownPurpose(purpose: string): purpose is MailOutboxPurpose {
  return (MAIL_OUTBOX_PURPOSES as readonly string[]).includes(purpose);
}

/**
 * Prüft, ob ein Versandauftrag noch versendet werden soll. Für alle Anlässe
 * gilt: Ein anonymisierter Mandant erhält keine Mail mehr. Danach entscheidet
 * der Zustand des Vorgangs. Unbekannte Anlässe oder ein abweichender
 * Vorgangstyp bleiben gewollt, damit die Prüfung nie stiller als bisher
 * blockiert.
 */
export async function checkMailOutboxRelevanceTx(
  db: MailOutboxRelevanceReader,
  row: MailOutboxRelevanceRow,
  now: Date = new Date(),
): Promise<MailOutboxRelevance> {
  const client = await db.client.findFirst({
    where: { id: row.clientId, tenantId: row.tenantId },
    select: { anonymizedAt: true },
  });
  if (!client) return obsolete('Der Mandant existiert nicht mehr.');
  if (client.anonymizedAt) return obsolete('Der Mandant wurde anonymisiert.');
  if (!isKnownPurpose(row.purpose)) return WANTED;
  const entry = CHECKS[row.purpose];
  if (entry.resourceType !== row.resourceType) return WANTED;
  return entry.check(
    db,
    { tenantId: row.tenantId, clientId: row.clientId, id: row.resourceId },
    now,
  );
}
