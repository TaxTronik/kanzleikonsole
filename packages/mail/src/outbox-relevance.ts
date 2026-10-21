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
//
// TCMS Stufe 4: Mitteilungen des Tax-CMS prüfen dagegen fail-closed: Ohne
// angekündigtes Gültigkeitsende, nach seinem Ablauf, mit fremdem Vorgangstyp
// oder wenn der Empfänger nicht mehr bestätigt zu diesem Mandanten gehört,
// geht nichts hinaus (MAIL-OUTBOX-001). „Bestätigt“ heißt aktiver
// Portalzugang nach der gemeinsamen Regel @taxtronik/db/portal-zugang
// (kk-tcms-fix5, s11 offener Punkt 5), dieselbe wie bei der Einplanung.
// =============================================================================

import type { Prisma } from '@prisma/client';
import {
  PORTAL_ZUGANG_SELECT,
  portalZugangMangel,
  type PortalZugangMangel,
} from '@taxtronik/db/portal-zugang';
import { MAIL_OUTBOX_PURPOSES, type MailOutboxPurpose } from './outbox-purposes';
import { istTcmsMailAnlass, TCMS_NACHRICHT_RESSOURCE } from './tcms-vorlagen';

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
  | 'appointment'
  | 'formSubmission'
  | 'clientContact'
>;

export interface MailOutboxRelevanceRow {
  tenantId: string;
  clientId: string;
  purpose: string;
  resourceType: string;
  resourceId: string;
  /**
   * Gespeicherter Auftragsinhalt; Welle 15: `relevance` enthält den Stand, den
   * die Mail ankündigt. Fehlt er, prüft die Aktualitätsprüfung nur den Status.
   */
  payload?: unknown;
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
  announced: Record<string, unknown> | null,
  /** Gespeicherter Auftragsinhalt (Empfängeradresse `to` für TCMS-Mitteilungen). */
  payload: unknown,
) => Promise<MailOutboxRelevance>;

const WANTED: MailOutboxRelevance = { wanted: true };

function obsolete(reason: string): MailOutboxRelevance {
  return { wanted: false, reason };
}

/**
 * Vermerk in `last_error` eines vor dem Versand verworfenen Auftrags (SKIPPED);
 * der Worker setzt ihn beim Claim (apps/worker/src/jobs/mail-outbox.ts).
 */
export function mailOutboxSkipVermerk(reason: string): string {
  return `${SKIP_PRAEFIX}${reason}`;
}
const SKIP_PRAEFIX = 'Nicht versendet: ';

/**
 * kk-tcms-s11 (MAIL-OUTBOX-001): feste Gründe, aus denen die
 * Aktualitätsprüfung eine Mitteilung des Tax-CMS verwirft (SKIPPED), ohne
 * personenbezogene Angaben. Der Zustell-Worker meldet dem Tax-CMS eine
 * verworfene Mitteilung als unzustellbar und liest den Grund dafür aus dem
 * Vermerk des Auftrags (`tcmsVerwerfGrund`); Prüfung und Abbildung nutzen
 * deshalb dieselben Texte.
 */
export const TCMS_VERWORFEN_TEXTE = {
  // Die beiden ersten gelten für jeden Anlass (checkMailOutboxRelevanceTx).
  MANDANT_FEHLT: 'Der Mandant existiert nicht mehr.',
  MANDANT_ANONYMISIERT: 'Der Mandant wurde anonymisiert.',
  FREMDER_VORGANG: 'Der Auftrag gehört zu keiner Mitteilung des Tax-CMS.',
  OHNE_ENDE: 'Die Mitteilung des Tax-CMS hat kein Gültigkeitsende.',
  ABGELAUFEN: 'Die Mitteilung des Tax-CMS ist abgelaufen.',
  EMPFAENGER_UNBESTIMMT: 'Der Empfänger der Mitteilung ist nicht bestimmt.',
  EMPFAENGER_FREMD: 'Der Empfänger gehört nicht (mehr) zu diesem Mandanten.',
  EMPFAENGER_INAKTIV: 'Der Empfänger ist nicht mehr aktiv.',
  ADRESSE_UNBESTAETIGT: 'Die Adresse des Empfängers ist nicht bestätigt.',
  ADRESSE_UNZUSTELLBAR: 'Die Adresse des Empfängers hat keine zustellbare Form.',
  MANDAT_INAKTIV: 'Das Mandat ist nicht mehr aktiv.',
  ADRESSE_GEAENDERT: 'Die E-Mail-Adresse des Empfängers hat sich geändert.',
} as const;
export type TcmsVerwerfGrund = keyof typeof TCMS_VERWORFEN_TEXTE;

/**
 * Grund eines verworfenen Auftrags zu einer Mitteilung des Tax-CMS aus seinem
 * Vermerk; `null`, wenn der Vermerk keiner der festen Gründe ist (etwa ein
 * anderer Verwerfer).
 */
export function tcmsVerwerfGrund(lastError: string | null): TcmsVerwerfGrund | null {
  if (!lastError?.startsWith(SKIP_PRAEFIX)) return null;
  const text = lastError.slice(SKIP_PRAEFIX.length);
  for (const [grund, vermerk] of Object.entries(TCMS_VERWORFEN_TEXTE)) {
    if (vermerk === text) return grund as TcmsVerwerfGrund;
  }
  return null;
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
 * verschobener Termin macht sie überholt; über die Änderung informiert eine
 * eigene Mail, wenn die Kanzlei sie beim Bearbeiten auswählt (Welle 15).
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

/** Terminstand, den eine Änderungsmail ankündigt (payload.relevance.appointment). */
export interface AnnouncedAppointment {
  /** ISO-8601-Instants. */
  startsAt: string;
  endsAt: string;
  title: string;
  location: string | null;
}

function announcedAppointment(
  announced: Record<string, unknown> | null,
): AnnouncedAppointment | null {
  const value = announced?.['appointment'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { startsAt, endsAt, title, location } = record;
  if (typeof startsAt !== 'string' || typeof endsAt !== 'string' || typeof title !== 'string') {
    return null;
  }
  if (location !== null && typeof location !== 'string') return null;
  return { startsAt, endsAt, title, location };
}

function sameInstant(iso: string, instant: Date): boolean {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed === instant.getTime();
}

/**
 * Welle 15: Änderungsmail zu einem Kanzleitermin. Überholt, wenn der Termin
 * abgesagt, erledigt oder bereits begonnen ist oder seitdem erneut geändert
 * wurde: Zeit, Titel oder Ort weichen vom angekündigten Stand ab. So geht bei
 * mehreren Änderungen nur die Mail mit dem aktuellen Stand hinaus.
 */
const appointmentChangeCurrent: Check = async (db, ref, now, announced) => {
  const appointment = await db.appointment.findFirst({
    where: scope(ref),
    select: { status: true, startsAt: true, endsAt: true, title: true, location: true },
  });
  if (!appointment) return obsolete('Der Termin existiert für diesen Mandanten nicht mehr.');
  if (appointment.status === 'CANCELLED') return obsolete('Der Termin wurde inzwischen abgesagt.');
  if (appointment.status === 'DONE') return obsolete('Der Termin ist bereits erledigt.');
  if (appointment.startsAt.getTime() <= now.getTime()) {
    return obsolete('Der Termin hat bereits begonnen.');
  }
  const expected = announcedAppointment(announced);
  if (
    expected &&
    !(
      sameInstant(expected.startsAt, appointment.startsAt) &&
      sameInstant(expected.endsAt, appointment.endsAt) &&
      expected.title === appointment.title &&
      expected.location === appointment.location
    )
  ) {
    return obsolete('Der Termin wurde seitdem erneut geändert.');
  }
  return WANTED;
};

/** Welle 15: Absagemail; eine Absage ist endgültig, ein begonnener Termin braucht keine. */
const appointmentStillCancelled: Check = async (db, ref, now) => {
  const appointment = await db.appointment.findFirst({
    where: scope(ref),
    select: { status: true, startsAt: true },
  });
  if (!appointment) return obsolete('Der Termin existiert für diesen Mandanten nicht mehr.');
  if (appointment.status !== 'CANCELLED') return obsolete('Der Termin ist nicht abgesagt.');
  if (appointment.startsAt.getTime() <= now.getTime()) {
    return obsolete('Der Termin hat bereits begonnen.');
  }
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadTo(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const to = (payload as Record<string, unknown>)['to'];
  return typeof to === 'string' ? to : null;
}

/**
 * kk-tcms-fix5: Grund eines verworfenen Auftrags je Mangel der gemeinsamen
 * Regel „aktiver Portalzugang“ (@taxtronik/db/portal-zugang; Reihenfolge der
 * Prüfung wie dort: Mandant, Kontakt, Adressform, Anmeldung).
 */
const VERWERF_GRUND_JE_MANGEL = {
  MANDANT_INAKTIV: 'MANDAT_INAKTIV',
  KONTAKT_INAKTIV: 'EMPFAENGER_INAKTIV',
  KONTAKT_OHNE_EMAIL: 'ADRESSE_UNZUSTELLBAR',
  KONTAKT_UNBESTAETIGT: 'ADRESSE_UNBESTAETIGT',
} as const satisfies Readonly<Record<PortalZugangMangel, TcmsVerwerfGrund>>;

/**
 * TCMS Stufe 4: Mitteilung des Tax-CMS an einen Mandantenkontakt. Gewollt nur
 * bis zum angekündigten Gültigkeitsende (`relevance.bis`: Ablauf des Codes bzw.
 * Anforderung plus Code-Lebensdauer) und nur, solange der Empfänger ein
 * Kontakt genau dieses Mandanten mit aktivem Portalzugang ist – dieselbe Regel
 * (@taxtronik/db/portal-zugang), unter der der Worker den Auftrag angelegt hat
 * – und seine Adresse noch die des Auftrags (`to`) ist. Fehlt eine Angabe:
 * verworfen.
 */
const tcmsMitteilungAktuell: Check = async (db, ref, now, announced, payload) => {
  const bis = typeof announced?.['bis'] === 'string' ? Date.parse(announced['bis']) : NaN;
  if (!Number.isFinite(bis)) return obsolete(TCMS_VERWORFEN_TEXTE.OHNE_ENDE);
  if (now.getTime() >= bis) return obsolete(TCMS_VERWORFEN_TEXTE.ABGELAUFEN);
  const kontaktId = announced?.['kontaktId'];
  const to = payloadTo(payload);
  if (typeof kontaktId !== 'string' || !UUID.test(kontaktId) || !to) {
    return obsolete(TCMS_VERWORFEN_TEXTE.EMPFAENGER_UNBESTIMMT);
  }
  const kontakt = await db.clientContact.findFirst({
    where: { id: kontaktId, tenantId: ref.tenantId, clientId: ref.clientId },
    select: PORTAL_ZUGANG_SELECT,
  });
  if (!kontakt) return obsolete(TCMS_VERWORFEN_TEXTE.EMPFAENGER_FREMD);
  const mangel = portalZugangMangel(kontakt);
  if (mangel) return obsolete(TCMS_VERWORFEN_TEXTE[VERWERF_GRUND_JE_MANGEL[mangel]]);
  // Zusätzlich zur gemeinsamen Regel: Die Adresse ist noch die des Auftrags.
  if (kontakt.email.trim().toLowerCase() !== to.trim().toLowerCase()) {
    return obsolete(TCMS_VERWORFEN_TEXTE.ADRESSE_GEAENDERT);
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
  'appointment-changed': { resourceType: 'appointment', check: appointmentChangeCurrent },
  'appointment-cancelled': { resourceType: 'appointment', check: appointmentStillCancelled },
  'tcms-freigabe-angefordert': {
    resourceType: TCMS_NACHRICHT_RESSOURCE,
    check: tcmsMitteilungAktuell,
  },
  'tcms-freigabe-code': { resourceType: TCMS_NACHRICHT_RESSOURCE, check: tcmsMitteilungAktuell },
  'tcms-freigabe-neu-adressiert': {
    resourceType: TCMS_NACHRICHT_RESSOURCE,
    check: tcmsMitteilungAktuell,
  },
};

/** `payload.relevance` eines Auftrags, sofern vorhanden. */
function announcedState(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const relevance = (payload as Record<string, unknown>)['relevance'];
  return relevance !== null && typeof relevance === 'object' && !Array.isArray(relevance)
    ? (relevance as Record<string, unknown>)
    : null;
}

function isKnownPurpose(purpose: string): purpose is MailOutboxPurpose {
  return (MAIL_OUTBOX_PURPOSES as readonly string[]).includes(purpose);
}

/**
 * Prüft, ob ein Versandauftrag noch versendet werden soll. Für alle Anlässe
 * gilt: Ein anonymisierter Mandant erhält keine Mail mehr. Danach entscheidet
 * der Zustand des Vorgangs. Unbekannte Anlässe oder ein abweichender
 * Vorgangstyp bleiben gewollt, damit die Prüfung nie stiller als bisher
 * blockiert – außer bei Mitteilungen des Tax-CMS (fail-closed, TCMS Stufe 4).
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
  if (!client) return obsolete(TCMS_VERWORFEN_TEXTE.MANDANT_FEHLT);
  if (client.anonymizedAt) return obsolete(TCMS_VERWORFEN_TEXTE.MANDANT_ANONYMISIERT);
  if (!isKnownPurpose(row.purpose)) return WANTED;
  const entry = CHECKS[row.purpose];
  if (entry.resourceType !== row.resourceType) {
    // TCMS-Mitteilungen fail-closed: nie ohne ihre Zustellzeile.
    return istTcmsMailAnlass(row.purpose) ? obsolete(TCMS_VERWORFEN_TEXTE.FREMDER_VORGANG) : WANTED;
  }
  return entry.check(
    db,
    { tenantId: row.tenantId, clientId: row.clientId, id: row.resourceId },
    now,
    announcedState(row.payload),
    row.payload,
  );
}
