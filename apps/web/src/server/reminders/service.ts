// =============================================================================
// Wiedervorlagen anlegen, klonen, nachfassen, kommentieren.
//
// Eine Wiedervorlage kann mehrere Zuständige haben (EINE Aufgabe — wer abhakt,
// erledigt sie für alle) und optional ohne Mandantenbezug auskommen.
// `predecessorId` verkettet Nachfragen: „Nachfrage zu …" ist eine neue Aufgabe
// mit eigener Frist und eigenem Status, die auf die vorige zeigt.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/staff-action';
import type { ReminderPriority } from '@/lib/reminder-priority';
import { notify } from '@/server/notifications/service';

export interface CreateReminderInput {
  tenantId: string;
  createdByStaff: string;
  /** null = interne Aufgabe ohne Mandantenbezug. */
  clientId: string | null;
  dueDate: Date;
  subject: string;
  notes: string | null;
  priority: ReminderPriority;
  assigneeStaffIds: string[];
  /** Vorgänger, wenn dies eine Nachfrage/Folgestufe ist. */
  predecessorId?: string | null;
}

const MAX_ASSIGNEES = 20;

/**
 * Legt eine Wiedervorlage samt Zuständigen an.
 *
 * Ohne ausdrückliche Zuweisung ist die anlegende Person zuständig — sonst
 * entstünde eine herrenlose Aufgabe, die in keiner „An mich"-Liste auftaucht.
 */
export async function createReminderTx(
  tx: TxClient,
  input: CreateReminderInput,
): Promise<{ id: string }> {
  const assignees = [...new Set(input.assigneeStaffIds)].filter(Boolean);
  if (assignees.length > MAX_ASSIGNEES) {
    throw new ActionError(`Höchstens ${MAX_ASSIGNEES} Zuständige je Wiedervorlage.`);
  }
  const wirksam = assignees.length > 0 ? assignees : [input.createdByStaff];

  // Zuständige müssen aktive Mitarbeitende DIESES Tenants sein — sonst
  // entstünde eine Zuweisung an eine fremde oder inaktive Staff-ID.
  const gueltig = await tx.staffUser.findMany({
    where: { id: { in: wirksam }, tenantId: input.tenantId, active: true },
    select: { id: true },
  });
  if (gueltig.length !== wirksam.length) {
    throw new ActionError('Mindestens eine zuständige Person ist unbekannt oder inaktiv.');
  }

  const reminder = await tx.clientReminder.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      dueDate: input.dueDate,
      subject: input.subject,
      notes: input.notes,
      priority: input.priority,
      createdByStaff: input.createdByStaff,
      predecessorId: input.predecessorId ?? null,
      assignees: { create: wirksam.map((staffId) => ({ staffId })) },
    },
    select: { id: true },
  });

  await notifyAssigneesTx(tx, {
    tenantId: input.tenantId,
    reminderId: reminder.id,
    clientId: input.clientId,
    subject: input.subject,
    dueDate: input.dueDate,
    von: input.createdByStaff,
    an: wirksam,
  });
  return reminder;
}

/**
 * Benachrichtigt die Zuständigen über eine Zuweisung.
 *
 * Vorher gab es NUR die tägliche Fälligkeits-Erinnerung: eine frisch
 * delegierte Aufgabe blieb bis zum nächsten Tageslauf unbemerkt — und weil die
 * Live-Aktualisierung der Oberfläche an der Benachrichtigungs-Glocke hängt,
 * tat sich beim Empfänger auch in der Anzeige nichts.
 *
 * Selbst-Zuweisung erzeugt bewusst nichts: wer sich eine Aufgabe notiert, muss
 * darüber nicht informiert werden.
 */
export async function notifyAssigneesTx(
  tx: TxClient,
  input: {
    tenantId: string;
    reminderId: string;
    clientId: string | null;
    subject: string;
    dueDate: Date;
    von: string;
    an: string[];
  },
): Promise<void> {
  const empfaenger = input.an.filter((id) => id !== input.von);
  if (empfaenger.length === 0) return;

  const vonName =
    (await tx.staffUser.findUnique({ where: { id: input.von }, select: { fullName: true } }))
      ?.fullName ?? 'Ein Kollege';
  const wo = input.clientId
    ? ((await tx.client.findUnique({ where: { id: input.clientId }, select: { name: true } }))
        ?.name ?? 'Mandant')
    : 'Intern';

  for (const staffId of empfaenger) {
    await notify(tx, {
      tenantId: input.tenantId,
      staffId,
      kind: 'CLIENT_REMINDER_ASSIGNED',
      title: `Neue Wiedervorlage: ${input.subject}`,
      body: `${vonName} hat dir eine Aufgabe zugewiesen · ${wo} · fällig ${input.dueDate.toISOString().slice(0, 10)}`,
      // Zielt auf die Detailseite — dort stehen Kette, Rückfragen und Anhänge.
      href: `/staff/reminders/${input.reminderId}`,
      resourceType: 'client_reminder',
      resourceId: input.reminderId,
    });
  }
}

export interface CloneOptions {
  /** true = Kette: die neue Aufgabe verweist auf die alte (Nachfrage). */
  alsNachfrage: boolean;
  dueDate: Date;
  subject?: string;
  notes?: string | null;
  assigneeStaffIds?: string[];
  priority?: ReminderPriority;
}

/**
 * Erzeugt aus einer bestehenden Wiedervorlage eine neue.
 *
 * Zwei Verwendungen mit demselben Mechanismus:
 *   Klonen     — dieselbe Aufgabe nochmal (z. B. wiederkehrende Prüfung),
 *                ohne Verweis auf das Original.
 *   Nachfassen — „Nachfrage zu …" mit Verweis auf die vorige Stufe; die Kette
 *                bleibt als Verlauf lesbar.
 *
 * Anhänge werden bewusst NICHT mitkopiert: eine Datei liegt einmal in der
 * Akte. Die Vorgänger-Verkettung macht sie im Verlauf ohnehin auffindbar.
 */
export async function cloneReminderTx(
  tx: TxClient,
  quelleId: string,
  actor: { tenantId: string; staffId: string },
  opts: CloneOptions,
): Promise<{ id: string }> {
  const quelle = await tx.clientReminder.findUnique({
    where: { id: quelleId },
    select: {
      clientId: true,
      subject: true,
      notes: true,
      priority: true,
      assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!quelle) throw new ActionError('Wiedervorlage nicht gefunden.');

  const subject =
    opts.subject?.trim() || (opts.alsNachfrage ? nachfrageTitel(quelle.subject) : quelle.subject);

  return createReminderTx(tx, {
    tenantId: actor.tenantId,
    createdByStaff: actor.staffId,
    clientId: quelle.clientId,
    dueDate: opts.dueDate,
    subject,
    notes: opts.notes !== undefined ? opts.notes : quelle.notes,
    priority: opts.priority ?? quelle.priority,
    assigneeStaffIds: opts.assigneeStaffIds ?? quelle.assignees.map((a) => a.staffId),
    predecessorId: opts.alsNachfrage ? quelleId : null,
  });
}

/**
 * Titel der Folgestufe. Mehrfaches Nachfassen soll nicht
 * „Nachfrage zu: Nachfrage zu: …" ergeben — stattdessen wird gezählt.
 */
export function nachfrageTitel(original: string): string {
  const m = /^Nachfrage (\d+) zu: (.*)$/s.exec(original);
  if (m) return `Nachfrage ${Number(m[1]) + 1} zu: ${m[2]}`;
  const erste = /^Nachfrage zu: (.*)$/s.exec(original);
  if (erste) return `Nachfrage 2 zu: ${erste[1]}`;
  return `Nachfrage zu: ${original}`;
}

/** Wortmeldung an einer Wiedervorlage (kurze Rückfrage ohne neue Frist). */
export async function addReminderNoteTx(
  tx: TxClient,
  input: { tenantId: string; reminderId: string; staffId: string; body: string },
): Promise<{ id: string }> {
  const body = input.body.trim();
  if (!body) throw new ActionError('Bitte einen Text eingeben.');
  return tx.clientReminderNote.create({
    data: {
      tenantId: input.tenantId,
      reminderId: input.reminderId,
      staffId: input.staffId,
      body,
    },
    select: { id: true },
  });
}

/** Setzt die Zuständigen neu (Zuweisung ändern). */
export async function setReminderAssigneesTx(
  tx: TxClient,
  input: { tenantId: string; reminderId: string; staffIds: string[]; von?: string },
): Promise<void> {
  const ziel = [...new Set(input.staffIds)].filter(Boolean);
  if (ziel.length === 0) throw new ActionError('Mindestens eine zuständige Person angeben.');
  if (ziel.length > MAX_ASSIGNEES) {
    throw new ActionError(`Höchstens ${MAX_ASSIGNEES} Zuständige je Wiedervorlage.`);
  }
  const gueltig = await tx.staffUser.findMany({
    where: { id: { in: ziel }, tenantId: input.tenantId, active: true },
    select: { id: true },
  });
  if (gueltig.length !== ziel.length) {
    throw new ActionError('Mindestens eine zuständige Person ist unbekannt oder inaktiv.');
  }

  // Wer schon zustaendig war, bekommt keine zweite Meldung — nur die neu
  // Hinzugekommenen erfahren davon.
  const vorher = new Set(
    (
      await tx.clientReminderAssignee.findMany({
        where: { reminderId: input.reminderId },
        select: { staffId: true },
      })
    ).map((a) => a.staffId),
  );

  await tx.clientReminderAssignee.deleteMany({
    where: { reminderId: input.reminderId, staffId: { notIn: ziel } },
  });
  await tx.clientReminderAssignee.createMany({
    data: ziel.map((staffId) => ({ reminderId: input.reminderId, staffId })),
    skipDuplicates: true,
  });

  const neu = ziel.filter((id) => !vorher.has(id));
  if (neu.length > 0 && input.von) {
    const rem = await tx.clientReminder.findUnique({
      where: { id: input.reminderId },
      select: { clientId: true, subject: true, dueDate: true },
    });
    if (rem) {
      await notifyAssigneesTx(tx, {
        tenantId: input.tenantId,
        reminderId: input.reminderId,
        clientId: rem.clientId,
        subject: rem.subject,
        dueDate: rem.dueDate,
        von: input.von,
        an: neu,
      });
    }
  }
}
