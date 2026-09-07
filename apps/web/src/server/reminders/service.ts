// =============================================================================
// Wiedervorlagen anlegen, klonen, nachfassen, kommentieren.
//
// Eine Wiedervorlage kann mehrere Zuständige haben (EINE Aufgabe — wer abhakt,
// erledigt sie für alle) und optional ohne Mandantenbezug auskommen.
// `predecessorId` verkettet Nachfragen: „Nachfrage zu …" ist eine neue Aufgabe
// mit eigener Frist und eigenem Status, die auf die vorige zeigt.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { ActionError } from '@/server/actions/staff-action';
import type { ReminderPriority } from '@/lib/reminder-priority';
import { notify } from '@/server/notifications/service';
import { extractMentions } from '@/lib/reminder-mentions';
import { assertClientAccessTx, filterStaffAccessClientTx } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import {
  assertReminderAccessTx,
  assertReminderActor,
  assertReminderNotArchived,
  lockReminderTx,
  REMINDER_ACCESS_SELECT,
} from './access';
import { persistReminderReferencesTx } from './references';

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
  /** Herkunft aus einer Telefonnotiz; mehrere Wiedervorlagen je Notiz erlaubt. */
  phoneNoteId?: string | null;
}

const MAX_ASSIGNEES = 20;

/**
 * Mandantenbezogene Aufgaben duerfen nur Personen zugewiesen werden, die den
 * Mandanten nach der kanzleiweiten Zugriffspolicy auch oeffnen duerfen. Im
 * OPEN-Modus laesst der zentrale Filter alle aktiven Tenant-Mitarbeitenden zu;
 * RESTRICTED und das Vertraulich-Flag begrenzen auf Verantwortliche bzw.
 * ADMIN/PARTNER. Interne Aufgaben ohne Mandantenbezug brauchen nur die oben
 * gepruefte Tenant-/Aktiv-Sanity.
 */
async function assertReminderAssigneeAccessTx(
  tx: TxClient,
  tenantId: string,
  staffIds: readonly string[],
  clientId: string | null,
): Promise<void> {
  if (!clientId || staffIds.length === 0) return;
  const erlaubt = await filterStaffAccessClientTx(tx, tenantId, staffIds, clientId);
  if (erlaubt.size !== staffIds.length) {
    throw new ActionError(
      'Mindestens eine zuständige Person darf auf diesen Mandanten nicht zugreifen.',
    );
  }
}

/**
 * Altzuweisungen bleiben zur Nachvollziehbarkeit bestehen, duerfen nach einem
 * Wechsel auf RESTRICTED oder beim nachtraeglichen Vertraulich-Markieren aber
 * keine neuen Sachverhaltsdaten mehr an ehemals Berechtigte tragen.
 */
async function filterCurrentReminderRecipientsTx(
  tx: TxClient,
  tenantId: string,
  staffIds: readonly string[],
  clientId: string | null,
): Promise<string[]> {
  const unique = [...new Set(staffIds)].filter(Boolean);
  if (!clientId || unique.length === 0) return unique;
  const allowed = await filterStaffAccessClientTx(tx, tenantId, unique, clientId);
  return unique.filter((staffId) => allowed.has(staffId));
}

/**
 * Legt eine Wiedervorlage samt Zuständigen an.
 *
 * Ohne ausdrückliche Zuweisung ist die anlegende Person zuständig — sonst
 * entstünde eine herrenlose Aufgabe, die in keiner „An mich"-Liste auftaucht.
 */
export async function createReminderTx(
  tx: TxClient,
  input: CreateReminderInput,
  session: StaffSession,
): Promise<{ id: string; ticketNumber: number }> {
  assertReminderActor(session, input.tenantId, input.createdByStaff);
  if (input.clientId) await assertClientAccessTx(tx, session, input.clientId);
  if (input.predecessorId) {
    const predecessor = await tx.clientReminder.findUnique({
      where: { id: input.predecessorId, tenantId: input.tenantId },
      select: REMINDER_ACCESS_SELECT,
    });
    if (!predecessor) throw new ActionError('Vorgänger nicht gefunden.');
    await assertReminderAccessTx(tx, session, predecessor);
  }
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
  await assertReminderAssigneeAccessTx(tx, input.tenantId, wirksam, input.clientId);

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
      phoneNoteId: input.phoneNoteId ?? null,
      assignees: { create: wirksam.map((staffId) => ({ staffId })) },
    },
    select: { id: true, ticketNumber: true },
  });

  await persistReminderReferencesTx(tx, session, reminder.id, input.notes ?? '');
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
 * Filtert Empfänger von AKTIVITÄTS-Meldungen (Chat, Uploads, Nachfassen) nach
 * ihrem persönlichen Modus: MENTIONS_ONLY heisst, vom laufenden Austausch nur
 * noch gezielte @-Ansprachen zu bekommen. Zuweisungen, Fälligkeiten und
 * Erwähnungen laufen NICHT über diesen Filter — die sind Arbeitsauftrag bzw.
 * direkte Ansprache, kein Rauschen.
 */
async function filterByNotifyMode(tx: TxClient, staffIds: string[]): Promise<string[]> {
  if (staffIds.length === 0) return [];
  const rows = await tx.staffUser.findMany({
    where: { id: { in: staffIds }, active: true, reminderNotifyMode: 'ALL' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Anzeigename einer Person — Fallback, falls das Konto inzwischen weg ist. */
async function staffName(tx: TxClient, staffId: string): Promise<string> {
  return (
    (await tx.staffUser.findUnique({ where: { id: staffId }, select: { fullName: true } }))
      ?.fullName ?? 'Ein Kollege'
  );
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
  const empfaenger = await filterCurrentReminderRecipientsTx(
    tx,
    input.tenantId,
    input.an.filter((id) => id !== input.von),
    input.clientId,
  );
  if (empfaenger.length === 0) return;

  const vonName = await staffName(tx, input.von);
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
  alsVerknuepftesTicket?: boolean;
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
  session: StaffSession,
): Promise<{ id: string; ticketNumber: number }> {
  assertReminderActor(session, actor.tenantId, actor.staffId);
  await lockReminderTx(tx, actor.tenantId, quelleId);
  const quelle = await tx.clientReminder.findUnique({
    where: { id: quelleId, tenantId: actor.tenantId },
    select: {
      archivedAt: true,
      clientId: true,
      subject: true,
      notes: true,
      priority: true,
      createdByStaff: true,
      assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!quelle) throw new ActionError('Wiedervorlage nicht gefunden.');
  await assertReminderAccessTx(tx, session, quelle);

  const subject =
    opts.subject?.trim() || (opts.alsNachfrage ? nachfrageTitel(quelle.subject) : quelle.subject);

  const zustaendige = opts.assigneeStaffIds ?? quelle.assignees.map((a) => a.staffId);
  const neu = await createReminderTx(
    tx,
    {
      tenantId: actor.tenantId,
      createdByStaff: actor.staffId,
      clientId: quelle.clientId,
      dueDate: opts.dueDate,
      subject,
      notes: opts.notes !== undefined ? opts.notes : quelle.notes,
      priority: opts.priority ?? quelle.priority,
      assigneeStaffIds: zustaendige,
      predecessorId: opts.alsNachfrage ? quelleId : null,
    },
    session,
  );
  if (opts.alsVerknuepftesTicket) {
    await tx.clientReminderReference.createMany({
      data: [{ tenantId: actor.tenantId, sourceReminderId: neu.id, targetReminderId: quelleId }],
      skipDuplicates: true,
    });
  }

  // Nachfassen ist ein Dialog, keine Einbahnstrasse: auch die Beteiligten der
  // URSPRUNGSSTUFE (delegierende Person + bisherige Zustaendige) erfahren von
  // der Folgestufe. Die Zustaendigen der NEUEN Stufe wurden soeben schon per
  // CLIENT_REMINDER_ASSIGNED informiert — sie bekommen keine zweite Meldung,
  // ebensowenig die ausloesende Person selbst.
  if (opts.alsNachfrage && !quelle.archivedAt) {
    const schonInformiert = new Set([...zustaendige, actor.staffId]);
    const aktuellBerechtigte = await filterCurrentReminderRecipientsTx(
      tx,
      actor.tenantId,
      [...new Set([quelle.createdByStaff, ...quelle.assignees.map((a) => a.staffId)])].filter(
        (id) => !schonInformiert.has(id),
      ),
      quelle.clientId,
    );
    const beteiligte = await filterByNotifyMode(tx, aktuellBerechtigte);
    if (beteiligte.length > 0) {
      const vonName = await staffName(tx, actor.staffId);
      for (const staffId of beteiligte) {
        await notify(tx, {
          tenantId: actor.tenantId,
          staffId,
          kind: 'CLIENT_REMINDER_FOLLOWUP',
          title: `Nachgefasst: ${quelle.subject}`,
          body: `${vonName} hat eine Folgestufe angelegt · fällig ${opts.dueDate.toISOString().slice(0, 10)}`,
          href: `/staff/reminders/${neu.id}`,
          resourceType: 'client_reminder',
          resourceId: neu.id,
        });
      }
    }
  }
  return neu;
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

/**
 * Wortmeldung an einer Wiedervorlage (kurze Rückfrage ohne neue Frist).
 *
 * Benachrichtigt alle Beteiligten (delegierende Person + Zuständige) ausser
 * der schreibenden — sonst verhallt eine Rückfrage, bis das Gegenüber
 * zufällig auf der Seite vorbeikommt.
 */
export async function addReminderNoteTx(
  tx: TxClient,
  input: { tenantId: string; reminderId: string; staffId: string; body: string },
  session: StaffSession,
): Promise<{ id: string }> {
  assertReminderActor(session, input.tenantId, input.staffId);
  const body = input.body.trim();
  if (!body) throw new ActionError('Bitte einen Text eingeben.');
  await lockReminderTx(tx, input.tenantId, input.reminderId);
  const rem = await tx.clientReminder.findUnique({
    where: { id: input.reminderId, tenantId: input.tenantId },
    select: { ...REMINDER_ACCESS_SELECT, archivedAt: true, subject: true },
  });
  if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
  await assertReminderAccessTx(tx, session, rem);
  assertReminderNotArchived(rem);
  const note = await tx.clientReminderNote.create({
    data: {
      tenantId: input.tenantId,
      reminderId: input.reminderId,
      staffId: input.staffId,
      body,
    },
    select: { id: true },
  });

  await persistReminderReferencesTx(tx, session, input.reminderId, body);
  if (rem) {
    const vonName = await staffName(tx, input.staffId);
    const auszug = body.length > 140 ? body.slice(0, 140) + '…' : body;
    const basis = {
      tenantId: input.tenantId,
      href: `/staff/reminders/${input.reminderId}`,
      resourceType: 'client_reminder_note',
      // Die NOTE-ID, nicht die Wiedervorlage: der Dedupe-Upsert kollabiert
      // gleiche (kind, resource, staffId) in EINE ungelesene Meldung. Mit der
      // Wiedervorlage als resource war nur die erste Nachricht hoerbar.
      resourceId: note.id,
    };

    // @-Erwaehnungen: gezielte Ansprache — geht auch an Nicht-Beteiligte,
    // sofern die den Vorgang ueberhaupt sehen duerfen (Mandanten-Policy bzw.
    // Beteiligung bei internen Aufgaben). Erwaehnungen umgehen den
    // persoenlichen Modus-Filter: wer @-genannt wird, ist gemeint.
    const beteiligtenKreis = new Set([rem.createdByStaff, ...rem.assignees.map((a) => a.staffId)]);
    const alleAktiven = await tx.staffUser.findMany({
      where: { tenantId: input.tenantId, active: true },
      select: { id: true, fullName: true },
    });
    const erwaehnt = new Set(
      extractMentions(body, alleAktiven).filter((id) => id !== input.staffId),
    );
    const kandidaten = [...new Set([...beteiligtenKreis, ...erwaehnt])];
    const aktuellBerechtigt = new Set(
      rem.clientId
        ? await filterCurrentReminderRecipientsTx(tx, input.tenantId, kandidaten, rem.clientId)
        : [...beteiligtenKreis],
    );
    for (const staffId of erwaehnt) {
      if (!aktuellBerechtigt.has(staffId)) continue;
      await notify(tx, {
        ...basis,
        staffId,
        kind: 'CLIENT_REMINDER_MENTION',
        title: `Du wurdest erwähnt: ${rem.subject}`,
        body: `${vonName}: ${auszug}`,
      });
    }

    // Beteiligte (ohne Autor, ohne bereits Erwaehnte) — gefiltert nach ihrem
    // persoenlichen Benachrichtigungs-Modus.
    const uebrige = [...beteiligtenKreis].filter(
      (id) => id !== input.staffId && !erwaehnt.has(id) && aktuellBerechtigt.has(id),
    );
    for (const staffId of await filterByNotifyMode(tx, uebrige)) {
      await notify(tx, {
        ...basis,
        staffId,
        kind: 'CLIENT_REMINDER_NOTE',
        title: `Rückfrage zu: ${rem.subject}`,
        body: `${vonName}: ${auszug}`,
      });
    }
  }
  return note;
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

  await lockReminderTx(tx, input.tenantId, input.reminderId);
  const rem = await tx.clientReminder.findFirst({
    where: { id: input.reminderId, tenantId: input.tenantId },
    select: { clientId: true, subject: true, dueDate: true, archivedAt: true },
  });
  if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
  assertReminderNotArchived(rem);
  await assertReminderAssigneeAccessTx(tx, input.tenantId, ziel, rem.clientId);

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
  const entfernt = [...vorher].filter((id) => !ziel.includes(id));
  if (entfernt.length > 0) {
    await resolveNotificationsTx(tx, {
      tenantId: input.tenantId,
      resources: [{ resourceType: 'client_reminder', resourceId: input.reminderId }],
      hrefs: [`/staff/reminders/${input.reminderId}`],
      staffIds: entfernt,
    });
  }

  await tx.clientReminderAssignee.deleteMany({
    where: { reminderId: input.reminderId, staffId: { notIn: ziel } },
  });
  await tx.clientReminderAssignee.createMany({
    data: ziel.map((staffId) => ({ reminderId: input.reminderId, staffId })),
    skipDuplicates: true,
  });

  const neu = ziel.filter((id) => !vorher.has(id));
  if (neu.length > 0 && input.von) {
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

/**
 * Benachrichtigt die Beteiligten über einen Dateianhang.
 *
 * Aufgerufen aus der Dokument-Commit-Route, in derselben Transaktion wie der
 * Dokument-Insert. Empfänger: delegierende Person + Zuständige, ausser der
 * hochladenden Person. `resourceId` ist das DOKUMENT — jeder Upload ist eine
 * eigene Meldung (siehe Kommentar bei der Wortmeldung: der Dedupe-Upsert
 * würde sonst Folge-Uploads stumm schalten).
 */
export async function notifyReminderAttachmentTx(
  tx: TxClient,
  input: {
    tenantId: string;
    reminderId: string;
    documentId: string;
    documentTitle: string;
    uploadedBy: string;
  },
): Promise<void> {
  await lockReminderTx(tx, input.tenantId, input.reminderId);
  const rem = await tx.clientReminder.findUnique({
    where: { id: input.reminderId, tenantId: input.tenantId },
    select: {
      archivedAt: true,
      clientId: true,
      subject: true,
      createdByStaff: true,
      assignees: { select: { staffId: true } },
    },
  });
  if (!rem || rem.archivedAt) return;

  const beteiligte = [
    ...new Set([rem.createdByStaff, ...rem.assignees.map((a) => a.staffId)]),
  ].filter((id) => id !== input.uploadedBy);
  const aktuellBerechtigte = await filterCurrentReminderRecipientsTx(
    tx,
    input.tenantId,
    beteiligte,
    rem.clientId,
  );
  const empfaenger = await filterByNotifyMode(tx, aktuellBerechtigte);
  if (empfaenger.length === 0) return;

  const vonName = await staffName(tx, input.uploadedBy);
  for (const staffId of empfaenger) {
    await notify(tx, {
      tenantId: input.tenantId,
      staffId,
      kind: 'CLIENT_REMINDER_ATTACHMENT',
      title: `Neue Datei an: ${rem.subject}`,
      body: `${vonName} hat „${input.documentTitle}" angehängt.`,
      href: `/staff/reminders/${input.reminderId}`,
      resourceType: 'document',
      resourceId: input.documentId,
    });
  }
}
