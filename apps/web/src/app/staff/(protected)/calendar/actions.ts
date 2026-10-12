'use server';

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { notify } from '@/server/notifications/service';
import {
  enqueueDirectMailTx,
  kickMailOutboxDelivery,
  type OutboxDirectMail,
} from '@/server/mail/outbox';
import {
  assertClientInTenant,
  assertStaffInTenant,
  TenantScopeError,
} from '@/server/db/assert-tenant';
import { assertClientAccessTx, canOtherStaffAccessClientTx } from '@/server/auth/rbac';
import {
  withStaffModule,
  staffAction,
  ActionError,
  parseActionInput,
  parseFormData,
  type ActionFailure,
  type ActionParseResult,
  type ActionResult as BaseActionResult,
  type StaffCtx,
} from '@/server/actions/staff-action';
import { formFlag } from '@/server/actions/form-data';
import {
  enqueueAppointmentClientMailTx,
  loadAppointmentMailOptionTx,
  type AppointmentClientMailOption,
} from '@/server/appointments/client-mail';
import { fmtDateTimeShort, fmtDateTimeMedium, berlinWallClockToUtc } from '@/lib/fmt';
import { audit } from '@/server/actions/audit';

const withAppointmentsStaff = withStaffModule('appointments');

export interface AppointmentActionResult extends BaseActionResult {
  id?: string;
  /** Welle 15: Zahl der angelegten Mandanten-Mails (je Empfänger ein Auftrag). */
  clientMails?: number;
}

const KindEnum = z.enum(['CLIENT_MEETING', 'INTERNAL', 'PRIVATE']);
const StatusEnum = z.enum(['PLANNED', 'CONFIRMED', 'CANCELLED', 'DONE']);

const CANCELLED_IS_FINAL = 'Ein abgesagter Termin kann nicht mehr geändert werden.';
const ALREADY_CANCELLED = 'Der Termin ist bereits abgesagt.';

const isoLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:MM');

const CreateSchema = z.object({
  title: z.string().trim().min(1, 'Bitte geben Sie einen Titel an.').max(200),
  ownerStaffId: z.string().uuid(),
  clientId: z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().uuid().nullable().optional(),
  ),
  kind: KindEnum.default('CLIENT_MEETING'),
  startsAt: isoLocal,
  endsAt: isoLocal,
  location: z.string().max(200).optional().or(z.literal('')),
  notes: z.string().max(4000).optional().or(z.literal('')),
});

function parseLocal(s: string): Date {
  // "YYYY-MM-DDTHH:MM" kommt zeitzonenlos aus <input type="datetime-local">
  // und meint Berlin-Wanduhrzeit. Als Berlin→UTC konvertieren (NICHT
  // new Date(s) = Server-Local): sonst verschiebt ein UTC-Container jeden
  // Termin um den Berlin-Offset gegenüber der fest Berlin-formatierten Anzeige.
  return berlinWallClockToUtc(s) ?? new Date(NaN);
}

export async function createAppointmentAction(
  _prev: AppointmentActionResult | null,
  formData: FormData,
): Promise<AppointmentActionResult> {
  const parsed = parseFormData(CreateSchema, formData);
  if (!parsed.ok) return parsed;
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { startsAt: ['Bitte wählen Sie einen gültigen Startzeitpunkt.'] },
    };
  }
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) {
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { endsAt: ['Das Ende muss nach dem Start liegen.'] },
    };
  }

  return withAppointmentsStaff(
    async (tx, { tenantId, staffId, session, ctx }) => {
      // P-7: Sanity-Check innerhalb des Tenants. RLS schützt cross-tenant,
      // aber FK greift nur auf Existenz im DB-Cluster — sonst kann ein
      // UI-Fehler einen ownerStaffId/clientId aus einem anderen Datenkontext
      // persistieren. Symmetrisch zu M-1.
      const owner = await tx.staffUser.findFirst({
        where: { id: parsed.data.ownerStaffId },
        select: { id: true },
      });
      if (!owner) throw new TenantScopeError('STAFF');
      if (parsed.data.clientId) {
        const cli = await tx.client.findFirst({
          where: { id: parsed.data.clientId },
          select: { id: true },
        });
        if (!cli) throw new TenantScopeError('CLIENT');
        // Vertraulich-/RESTRICTED-Ventil bei Mandantenbezug.
        await assertClientAccessTx(tx, session, parsed.data.clientId);
        if (
          !(await canOtherStaffAccessClientTx(
            tx,
            tenantId,
            parsed.data.ownerStaffId,
            parsed.data.clientId,
          ))
        ) {
          throw new ActionError(
            'Die ausgewählte Person hat nach dem Kanzlei-Zugriffsmodus keinen Zugriff auf diesen Mandanten.',
          );
        }
      }
      const appt = await tx.appointment.create({
        data: {
          tenantId,
          ownerStaffId: parsed.data.ownerStaffId,
          createdByStaff: staffId,
          clientId: parsed.data.clientId ?? null,
          kind: parsed.data.kind,
          title: parsed.data.title.trim(),
          location: parsed.data.location?.trim() || null,
          notes: parsed.data.notes?.trim() || null,
          startsAt,
          endsAt,
        },
      });
      await audit(tx, ctx, {
        action: 'appointment.create',
        resourceType: 'appointment',
        resourceId: appt.id,
        after: {
          title: parsed.data.title,
          ownerStaffId: parsed.data.ownerStaffId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          clientId: parsed.data.clientId ?? null,
        },
      });
      return { id: appt.id };
    },
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines'] },
  );
}

const UpdateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1, 'Bitte geben Sie einen Titel an.').max(200),
  ownerStaffId: z.string().uuid(),
  clientId: z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().uuid().nullable().optional(),
  ),
  kind: KindEnum.default('CLIENT_MEETING'),
  status: StatusEnum.default('PLANNED'),
  startsAt: isoLocal,
  endsAt: isoLocal,
  location: z.string().max(200).optional().or(z.literal('')),
  notes: z.string().max(4000).optional().or(z.literal('')),
  // Welle 15: Checkbox „Mandant per E-Mail informieren“ (fehlt = nicht angehakt).
  notifyClient: formFlag(),
});

const REVALIDATE_APPOINTMENT = ['/staff/calendar', '/staff/tax-deadlines', '/portal/appointments'];

function fieldFailure(field: string, message: string): ActionFailure {
  return {
    ok: false,
    error: 'Bitte prüfen Sie die markierten Angaben.',
    errorCode: 'VALIDATION_ERROR',
    fieldErrors: { [field]: [message] },
  };
}

interface AppointmentUpdate {
  input: z.infer<typeof UpdateSchema>;
  startsAt: Date;
  endsAt: Date;
}

function parseAppointmentUpdate(formData: FormData): ActionParseResult<AppointmentUpdate> {
  const parsed = parseFormData(UpdateSchema, formData);
  if (!parsed.ok) return parsed;
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return fieldFailure('startsAt', 'Bitte wählen Sie einen gültigen Startzeitpunkt.');
  }
  if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) {
    return fieldFailure('endsAt', 'Das Ende muss nach dem Start liegen.');
  }
  // C1: Absagen ist ein eigener, auditierter Schritt (cancelAppointmentAction)
  // statt eines Statuswerts im Bearbeiten-Formular.
  if (parsed.data.status === 'CANCELLED') {
    return fieldFailure('status', 'Einen Termin sagen Sie über „Termin absagen“ ab.');
  }
  return { ok: true, data: { input: parsed.data, startsAt, endsAt } };
}

/** Ergebnis der Termin-Transaktion: ohne erreichbaren Empfänger wird nichts geschrieben. */
type AppointmentTxOutcome =
  | { kind: 'saved'; clientMails: number }
  | { kind: 'no-recipient'; reason: string };

const BEFORE_UPDATE_SELECT = {
  title: true,
  startsAt: true,
  endsAt: true,
  status: true,
  clientId: true,
  ownerStaffId: true,
  location: true,
  fromRequestId: true,
} as const;

type AppointmentBefore = {
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  clientId: string | null;
  ownerStaffId: string;
  location: string | null;
  fromRequestId: string | null;
};

/** Neuer Stand aus dem Bearbeiten-Formular (getrimmt wie gespeichert). */
interface AppointmentNext {
  id: string;
  title: string;
  ownerStaffId: string;
  clientId: string | null;
  kind: z.infer<typeof KindEnum>;
  status: z.infer<typeof StatusEnum>;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  notes: string | null;
}

/** Tenant-Sanity und Zugriffsventile für alten UND neuen Mandantenbezug. */
async function assertAppointmentUpdateAllowedTx(
  tx: TxClient,
  { tenantId, session }: Pick<StaffCtx, 'tenantId' | 'session'>,
  before: AppointmentBefore,
  next: AppointmentNext,
): Promise<void> {
  // P-7 (Befund 5): ownerStaffId/clientId Tenant-Sanity — das Create-
  // Pendant oben prüft, der Update-Pfad fehlte.
  await assertStaffInTenant(tx, next.ownerStaffId);
  if (next.clientId) await assertClientInTenant(tx, next.clientId);
  // Vertraulich-/RESTRICTED-Ventil für alten UND neuen Mandantenbezug.
  if (before.clientId) await assertClientAccessTx(tx, session, before.clientId);
  // C1: Eine Absage ist endgültig; geprüft erst nach dem Zugriffsventil.
  if (before.status === 'CANCELLED') throw new ActionError(CANCELLED_IS_FINAL);
  if (!next.clientId) return;
  await assertClientAccessTx(tx, session, next.clientId);
  if (!(await canOtherStaffAccessClientTx(tx, tenantId, next.ownerStaffId, next.clientId))) {
    throw new ActionError(
      'Die ausgewählte Person hat nach dem Kanzlei-Zugriffsmodus keinen Zugriff auf diesen Mandanten.',
    );
  }
}

/** Hinweise an Zuständige: erledigt → schließen; Wechsel → an die neue Person. */
async function syncAppointmentNotificationsTx(
  tx: TxClient,
  { tenantId, staffId }: Pick<StaffCtx, 'tenantId' | 'staffId'>,
  before: AppointmentBefore,
  next: AppointmentNext,
): Promise<void> {
  const resources = [{ resourceType: 'appointment', resourceId: next.id }];
  if (next.status === 'DONE') {
    await resolveNotificationsTx(tx, { tenantId, resources });
    return;
  }
  if (before.ownerStaffId === next.ownerStaffId) return;
  // Zuständigkeitswechsel: der alte Hinweis darf nicht bei der vorherigen
  // Person liegen bleiben. Die neue Person erhält denselben direkten
  // Einstieg wie beim Annehmen einer Terminanfrage.
  await resolveNotificationsTx(tx, { tenantId, resources, staffIds: [before.ownerStaffId] });
  if (next.ownerStaffId === staffId) return;
  await notify(tx, {
    tenantId,
    staffId: next.ownerStaffId,
    kind: 'APPOINTMENT_REQUESTED',
    title: `Termin übernommen: ${next.title}`,
    body: fmtDateTimeShort(next.startsAt),
    href: '/staff/calendar',
    resourceType: 'appointment',
    resourceId: next.id,
  });
}

/**
 * Welle 15: Die Änderungsmail nennt Titel, Zeit und Ort; ohne Änderung daran
 * gibt es nichts mitzuteilen, und ein erledigter Termin braucht keine.
 */
function announcesChange(before: AppointmentBefore, next: AppointmentNext): boolean {
  if (next.status === 'DONE') return false;
  return (
    before.title !== next.title ||
    before.startsAt.getTime() !== next.startsAt.getTime() ||
    before.endsAt.getTime() !== next.endsAt.getTime() ||
    before.location !== next.location
  );
}

/** Empfänger klären, bevor etwas geschrieben wird; null = keine Mail gewünscht. */
async function mailOptionTx(
  tx: TxClient,
  notifyClient: boolean,
  appointment: { id: string; clientId: string | null; fromRequestId: string | null },
): Promise<AppointmentClientMailOption | AppointmentTxOutcome | null> {
  if (!notifyClient) return null;
  const option = await loadAppointmentMailOptionTx(tx, appointment);
  if (option.recipients.length > 0) return option;
  return {
    kind: 'no-recipient',
    reason: option.unavailableReason ?? 'Kein erreichbarer Empfänger.',
  };
}

function isOutcome(
  value: AppointmentClientMailOption | AppointmentTxOutcome | null,
): value is AppointmentTxOutcome {
  return value !== null && 'kind' in value;
}

/** Nach dem Commit: Feldfehler zurückgeben oder den Worker anstoßen (F-08). */
function finishAppointmentAction(
  outcome: AppointmentTxOutcome,
): ActionFailure | { clientMails: number } {
  if (outcome.kind === 'no-recipient') return fieldFailure('notifyClient', outcome.reason);
  // Versand erst nach dem Commit; der Minutentakt holt einen verlorenen Anstoß nach.
  if (outcome.clientMails > 0) kickMailOutboxDelivery();
  return { clientMails: outcome.clientMails };
}

async function updateAppointmentTx(
  tx: TxClient,
  g: StaffCtx,
  next: AppointmentNext,
  notifyClient: boolean,
): Promise<AppointmentTxOutcome> {
  const before = await tx.appointment.findUnique({
    where: { id: next.id },
    select: BEFORE_UPDATE_SELECT,
  });
  if (!before) throw new ActionError('Termin nicht gefunden.');
  await assertAppointmentUpdateAllowedTx(tx, g, before, next);
  // Welle 15: Empfänger für den NEUEN Mandantenbezug vor jedem Schreibzugriff.
  const mailOption = await mailOptionTx(tx, notifyClient, {
    id: next.id,
    clientId: next.clientId,
    fromRequestId: before.fromRequestId,
  });
  if (isOutcome(mailOption)) return mailOption;
  // Bedingt auf „nicht abgesagt": Ein offenes Bearbeiten-Formular darf eine
  // inzwischen erfolgte Absage nicht still mit seinem alten Status überschreiben.
  const updated = await tx.appointment.updateMany({
    where: { id: next.id, status: { not: 'CANCELLED' } },
    data: {
      title: next.title,
      ownerStaffId: next.ownerStaffId,
      clientId: next.clientId,
      kind: next.kind,
      status: next.status,
      startsAt: next.startsAt,
      endsAt: next.endsAt,
      location: next.location,
      notes: next.notes,
    },
  });
  if (updated.count === 0) throw new ActionError(CANCELLED_IS_FINAL);
  await syncAppointmentNotificationsTx(tx, g, before, next);
  const clientMails =
    mailOption && next.clientId && announcesChange(before, next)
      ? await enqueueAppointmentClientMailTx(tx, {
          tenantId: g.tenantId,
          clientId: next.clientId,
          purpose: 'appointment-changed',
          appointment: next,
          recipients: mailOption.recipients,
          now: new Date(),
        })
      : 0;
  await audit(tx, g.ctx, {
    action: 'appointment.update',
    resourceType: 'appointment',
    resourceId: next.id,
    before: {
      title: before.title,
      status: before.status,
      ownerStaffId: before.ownerStaffId,
      clientId: before.clientId,
      startsAt: before.startsAt.toISOString(),
      endsAt: before.endsAt.toISOString(),
    },
    after: {
      title: next.title,
      status: next.status,
      ownerStaffId: next.ownerStaffId,
      startsAt: next.startsAt.toISOString(),
      endsAt: next.endsAt.toISOString(),
      ...(clientMails > 0 ? { clientMails } : {}),
    },
  });
  return { kind: 'saved', clientMails };
}

/**
 * Speichert den Bearbeiten-Dialog. Welle 15: Mit „Mandant per E-Mail
 * informieren“ entsteht im selben Commit je Empfänger ein Versandauftrag
 * „Terminänderung“ (Mail-Outbox, MAIL-OUTBOX-001) — nur wenn sich Titel, Zeit
 * oder Ort ändern und der Termin nicht als erledigt gespeichert wird. Ohne
 * erreichbaren Empfänger wird nichts gespeichert, sondern das Feld markiert.
 */
export async function updateAppointmentAction(
  _prev: AppointmentActionResult | null,
  formData: FormData,
): Promise<AppointmentActionResult> {
  return staffAction({
    guard: { module: 'appointments' },
    parse: () => parseAppointmentUpdate(formData),
    revalidate: REVALIDATE_APPOINTMENT,
    run: async (g, { input, startsAt, endsAt }) => {
      const next: AppointmentNext = {
        id: input.id,
        title: input.title.trim(),
        ownerStaffId: input.ownerStaffId,
        clientId: input.clientId ?? null,
        kind: input.kind,
        status: input.status,
        startsAt,
        endsAt,
        location: input.location?.trim() || null,
        notes: input.notes?.trim() || null,
      };
      const outcome = await withTenantContext(g.ctx, (tx) =>
        updateAppointmentTx(tx, g, next, input.notifyClient),
      );
      return finishAppointmentAction(outcome);
    },
  });
}

const CancelSchema = z.object({
  id: z.string().uuid(),
  // Welle 15: Checkbox „Mandant per E-Mail informieren“ im Absagen-Dialog.
  notifyClient: z.boolean().default(false),
});

/**
 * Review-Befund C1: Absagen statt Löschen. Der Termin bleibt mit Status
 * CANCELLED erhalten (Kalender zeigt ihn als abgesagt; Übersichten, Portal und
 * iCal-Feed blenden ihn aus) und wird auditiert. Eine noch ausstehende
 * Terminbestätigung oder Änderungsmail verwirft der Mail-Worker vor dem
 * Versand. Welle 15: Mit „Mandant per E-Mail informieren“ entsteht im selben
 * Commit je Empfänger ein Versandauftrag „Absage des Termins“; ohne Häkchen
 * keine Mail.
 */
export async function cancelAppointmentAction(input: {
  id: string;
  notifyClient?: boolean;
}): Promise<AppointmentActionResult> {
  return staffAction({
    guard: { module: 'appointments' },
    parse: () => parseActionInput(CancelSchema, input, 'Ungültige Termin-ID.'),
    revalidate: REVALIDATE_APPOINTMENT,
    run: async ({ tenantId, session, ctx }, data) => {
      const outcome = await withTenantContext(ctx, async (tx): Promise<AppointmentTxOutcome> => {
        const before = await tx.appointment.findUnique({
          where: { id: data.id },
          select: {
            title: true,
            status: true,
            clientId: true,
            ownerStaffId: true,
            startsAt: true,
            endsAt: true,
            location: true,
            fromRequestId: true,
          },
        });
        if (!before) throw new ActionError('Termin nicht gefunden.');
        // Vertraulich-/RESTRICTED-Ventil vor jeder Statusauskunft.
        if (before.clientId) await assertClientAccessTx(tx, session, before.clientId);
        if (before.status === 'CANCELLED') throw new ActionError(ALREADY_CANCELLED);
        const mailOption = await mailOptionTx(tx, data.notifyClient, {
          id: data.id,
          clientId: before.clientId,
          fromRequestId: before.fromRequestId,
        });
        if (isOutcome(mailOption)) return mailOption;
        // CAS: Zwei parallele Absagen erzeugen nur einen Statuswechsel und ein Audit.
        const cancelled = await tx.appointment.updateMany({
          where: { id: data.id, status: { not: 'CANCELLED' } },
          data: { status: 'CANCELLED' },
        });
        if (cancelled.count === 0) throw new ActionError(ALREADY_CANCELLED);
        await resolveNotificationsTx(tx, {
          tenantId,
          resources: [{ resourceType: 'appointment', resourceId: data.id }],
        });
        const clientMails =
          mailOption && before.clientId
            ? await enqueueAppointmentClientMailTx(tx, {
                tenantId,
                clientId: before.clientId,
                purpose: 'appointment-cancelled',
                appointment: {
                  id: data.id,
                  title: before.title,
                  startsAt: before.startsAt,
                  endsAt: before.endsAt,
                  location: before.location,
                },
                recipients: mailOption.recipients,
                now: new Date(),
              })
            : 0;
        await audit(tx, ctx, {
          action: 'appointment.cancel',
          resourceType: 'appointment',
          resourceId: data.id,
          before: {
            title: before.title,
            status: before.status,
            ownerStaffId: before.ownerStaffId,
            clientId: before.clientId,
            startsAt: before.startsAt.toISOString(),
            endsAt: before.endsAt.toISOString(),
            fromRequestId: before.fromRequestId,
          },
          after: { status: 'CANCELLED', ...(clientMails > 0 ? { clientMails } : {}) },
        });
        return { kind: 'saved', clientMails };
      });
      return finishAppointmentAction(outcome);
    },
  });
}

// -------------------------------------------------------------------------
// Termin-Anfragen entscheiden
// -------------------------------------------------------------------------

interface DecisionContact {
  fullName: string;
  email: string;
  notificationsEnabled: boolean;
  active: boolean;
}

/**
 * Entscheidungs-Mail an den anfragenden Mandanten-Kontakt (nur aktiv und mit
 * Benachrichtigungen). F-08: im Entscheidungs-Commit als Versandauftrag; der
 * Worker stellt mit Retry zu. Liefert, ob ein Auftrag angelegt wurde.
 */
async function enqueueAppointmentDecisionMailTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    requestId: string;
    purpose: 'appointment-confirmed' | 'appointment-rejected';
    contact: DecisionContact | null;
    mail: (contact: { fullName: string; email: string }) => Omit<OutboxDirectMail, 'to'>;
  },
): Promise<boolean> {
  const contact = input.contact;
  if (!contact || !contact.active || !contact.notificationsEnabled) return false;
  await enqueueDirectMailTx(
    tx,
    {
      tenantId: input.tenantId,
      clientId: input.clientId,
      purpose: input.purpose,
      resource: { type: 'appointment_request', id: input.requestId },
      staffHref: '/staff/calendar',
    },
    { ...input.mail(contact), to: contact.email },
  );
  return true;
}

const AcceptSchema = z.object({
  requestId: z.string().uuid(),
  slotIndex: z.number().int().min(0).max(10),
  ownerStaffId: z.string().uuid(),
});

export async function acceptAppointmentRequestAction(input: {
  requestId: string;
  slotIndex: number;
  ownerStaffId: string;
}): Promise<AppointmentActionResult> {
  const parsed = AcceptSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'Ungültige Terminauswahl.', errorCode: 'VALIDATION_ERROR' };

  // Befund 4: SMTP-Versand nicht innerhalb der Tx (Timeout-/Doppelversand-
  // Risiko bei Rollback nach Versand). F-08: Der Versandauftrag entsteht im
  // Commit, der Worker versendet danach.
  let mailQueued = false;

  const r = await withAppointmentsStaff(
    async (tx, { tenantId, staffId, session, ctx }) => {
      // P-7 (Befund 5): ownerStaffId Tenant-Sanity — FK prüft nur Existenz.
      await assertStaffInTenant(tx, parsed.data.ownerStaffId);
      const req = await tx.appointmentRequest.findUnique({
        where: { id: parsed.data.requestId },
        select: {
          id: true,
          clientId: true,
          subject: true,
          notes: true,
          status: true,
          proposedSlots: true,
          createdByContact: true,
          client: { select: { name: true } },
          createdByContactRel: {
            select: { fullName: true, email: true, notificationsEnabled: true, active: true },
          },
        },
      });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.status !== 'PENDING') throw new ActionError('Anfrage bereits entschieden.');
      // Vertraulich-/RESTRICTED-Ventil.
      await assertClientAccessTx(tx, session, req.clientId);
      if (
        !(await canOtherStaffAccessClientTx(tx, tenantId, parsed.data.ownerStaffId, req.clientId))
      ) {
        throw new ActionError(
          'Die ausgewählte Person hat nach dem Kanzlei-Zugriffsmodus keinen Zugriff auf diesen Mandanten.',
        );
      }

      const slots = req.proposedSlots as Array<{ startsAt: string; endsAt: string }>;
      const slot = slots[parsed.data.slotIndex];
      if (!slot) throw new ActionError('Ungültiger Slot.');
      // Slots sind zeitzonenlose Berlin-Wanduhr-Strings (Portal-Eingabe) —
      // als Berlin→UTC konvertieren, konsistent zu parseLocal.
      const startsAt = berlinWallClockToUtc(slot.startsAt) ?? new Date(NaN);
      const endsAt = berlinWallClockToUtc(slot.endsAt) ?? new Date(NaN);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        throw new ActionError('Slot-Zeitstempel kaputt.');
      }

      // TOCTOU-Schutz: Anfrage zuerst atomar claimen (PENDING → ACCEPTED),
      // BEVOR der Termin angelegt wird. Zwei parallele Accepts würden sonst
      // zwei bestätigte Termine + zwei Bestätigungs-Mails erzeugen.
      const claim = await tx.appointmentRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          acceptedSlot: slot as unknown as Prisma.InputJsonValue,
          decidedByStaff: staffId,
          decidedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new ActionError('Anfrage bereits entschieden.');
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'appointment_request', resourceId: req.id }],
      });

      const appt = await tx.appointment.create({
        data: {
          tenantId,
          ownerStaffId: parsed.data.ownerStaffId,
          createdByStaff: staffId,
          clientId: req.clientId,
          kind: 'CLIENT_MEETING',
          status: 'CONFIRMED',
          title: req.subject,
          notes: req.notes,
          startsAt,
          endsAt,
          fromRequestId: req.id,
        },
      });

      await tx.appointmentRequest.update({
        where: { id: req.id },
        data: { acceptedAppointmentId: appt.id },
      });

      await audit(tx, ctx, {
        action: 'appointment_request.accept',
        resourceType: 'appointment_request',
        resourceId: req.id,
        after: { appointmentId: appt.id, slotIndex: parsed.data.slotIndex },
      });
      await audit(tx, ctx, {
        action: 'appointment.create',
        resourceType: 'appointment',
        resourceId: appt.id,
        after: { fromRequest: req.id, startsAt: startsAt.toISOString() },
      });

      // Notification an Owner (sofern nicht ich selbst Owner bin)
      if (parsed.data.ownerStaffId !== staffId) {
        await notify(tx, {
          tenantId,
          staffId: parsed.data.ownerStaffId,
          kind: 'APPOINTMENT_REQUESTED',
          title: `Neuer Termin: ${req.client.name}`,
          body: `${req.subject} — ${fmtDateTimeShort(startsAt)}`,
          href: `/staff/calendar`,
          resourceType: 'appointment',
          resourceId: appt.id,
        });
      }

      // Bestätigungs-Mail an den Mandanten-Kontakt — Empfänger sehen wir nur
      // hier in der Tx; versendet wird nach dem Commit (Befund 4, F-08).
      mailQueued = await enqueueAppointmentDecisionMailTx(tx, {
        tenantId,
        clientId: req.clientId,
        requestId: req.id,
        purpose: 'appointment-confirmed',
        contact: req.createdByContactRel,
        mail: (contact) => ({
          slug: 'appointment-confirmed',
          vars: {
            contact: { fullName: contact.fullName, email: contact.email },
            appointment: {
              title: req.subject,
              startsAt: fmtDateTimeMedium(startsAt),
              location: '',
            },
          },
          // Befund 7 (Bug-Klasse R-5): vorher fälschlich 'client.created'.
          n8nEvent: 'appointment.responded',
          n8nPayload: {
            tenantId,
            kind: 'appointment-accepted',
            appointmentId: appt.id,
            requestId: req.id,
            clientId: req.clientId,
          },
          fallback: {
            subject: 'Termin-Bestätigung: {{appointment.title}}',
            bodyMd:
              'Sehr geehrte/r {{contact.fullName}},\n\nwir bestätigen Ihren Termin:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}',
          },
        }),
      });
    },
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines', '/portal/appointments'] },
  );

  // Mail-Fehler kippen die bereits committete Entscheidung nicht (Befund 3/4).
  if (r.ok && mailQueued) kickMailOutboxDelivery();
  return r;
}

const RejectSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string().max(500).optional().or(z.literal('')),
});

export async function rejectAppointmentRequestAction(input: {
  requestId: string;
  reason?: string;
}): Promise<AppointmentActionResult> {
  const parsed = RejectSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: 'Ungültige Ablehnung.', errorCode: 'VALIDATION_ERROR' };

  // Befund 4: Versandauftrag in der Tx, Versand nach dem Commit (F-08).
  let mailQueued = false;

  const r = await withAppointmentsStaff(
    async (tx, { tenantId, staffId, session, ctx }) => {
      const req = await tx.appointmentRequest.findUnique({
        where: { id: parsed.data.requestId },
        select: {
          id: true,
          status: true,
          subject: true,
          clientId: true,
          createdByContactRel: {
            select: { fullName: true, email: true, notificationsEnabled: true, active: true },
          },
        },
      });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.status !== 'PENDING') throw new ActionError('Anfrage bereits entschieden.');
      await assertClientAccessTx(tx, session, req.clientId);

      // TOCTOU-Schutz: atomarer Claim (PENDING → REJECTED).
      const claim = await tx.appointmentRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectionReason: parsed.data.reason?.trim() || null,
          decidedByStaff: staffId,
          decidedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new ActionError('Anfrage bereits entschieden.');
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'appointment_request', resourceId: req.id }],
      });
      await audit(tx, ctx, {
        action: 'appointment_request.reject',
        resourceType: 'appointment_request',
        resourceId: req.id,
        after: { reason: parsed.data.reason ?? null },
      });

      mailQueued = await enqueueAppointmentDecisionMailTx(tx, {
        tenantId,
        clientId: req.clientId,
        requestId: req.id,
        purpose: 'appointment-rejected',
        contact: req.createdByContactRel,
        mail: (contact) => ({
          slug: 'appointment-rejected',
          vars: {
            contact: { fullName: contact.fullName, email: contact.email },
            request: { subject: req.subject },
            rejectionReason:
              parsed.data.reason?.trim() ||
              'Bitte schlagen Sie über das Portal alternative Zeiten vor.',
          },
          // Befund 7 (Bug-Klasse R-5): vorher fälschlich 'client.created'.
          n8nEvent: 'appointment.responded',
          n8nPayload: {
            tenantId,
            kind: 'appointment-rejected',
            requestId: req.id,
          },
          fallback: {
            subject: 'Ihre Termin-Anfrage konnten wir leider nicht annehmen',
            bodyMd:
              'Sehr geehrte/r {{contact.fullName}},\n\nleider können wir Ihre Termin-Anfrage „{{request.subject}}" nicht annehmen.\n\n{{rejectionReason}}',
          },
        }),
      });
    },
    { revalidate: ['/staff/calendar', '/portal/appointments'] },
  );

  // Befund 3/4: Mail-Fehler kippen die committete Entscheidung nicht.
  if (r.ok && mailQueued) kickMailOutboxDelivery();
  return r;
}
