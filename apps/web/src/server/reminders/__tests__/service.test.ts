import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Anlegen / Klonen / Nachfassen — mehrere Zuständige, optionaler Mandant.
// =============================================================================

vi.mock('@/server/actions/staff-action', () => {
  class ActionError extends Error {}
  return { ActionError };
});

const notifyMock = vi.hoisted(() => vi.fn());
const canAccessMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('@/server/notifications/service', () => ({ notify: notifyMock }));
// rbac zieht transitiv next-auth — fuer den Unit-Test gemockt.
vi.mock('@/server/auth/rbac', () => ({ canOtherStaffAccessClientTx: canAccessMock }));

import { ActionError } from '@/server/actions/staff-action';
import {
  addReminderNoteTx,
  cloneReminderTx,
  createReminderTx,
  nachfrageTitel,
  notifyReminderAttachmentTx,
  setReminderAssigneesTx,
} from '../service';

const TENANT = 'tenant-1';
const ICH = 'staff-ich';
const A = 'staff-a';
const B = 'staff-b';

/** Form der `create`-Nutzlast, soweit die Tests sie prüfen. */
interface CreateData {
  clientId: string | null;
  subject: string;
  priority: string;
  predecessorId: string | null;
  body?: string;
  assignees?: { create: Array<{ staffId: string }> };
}

/** Liest das `data`-Objekt des letzten create-Aufrufs typsicher aus. */
function letzteCreateData(fn: { mock: { calls: unknown[][] } }): CreateData {
  const call = fn.mock.calls.at(-1);
  if (!call) throw new Error('create wurde nicht aufgerufen');
  return (call[0] as { data: CreateData }).data;
}

function makeTx(over: Record<string, unknown> = {}) {
  return {
    staffUser: {
      // Beantwortet drei Abfrage-Formen: Kandidaten-Pruefung ({id:{in}}),
      // Modus-Filter ({id:{in}, reminderNotifyMode}) und Mention-Kandidaten
      // ({tenantId, active} → alle bekannten Personen mit Namen).
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id
          ? where.id.in.map((id) => ({ id }))
          : [
              { id: ICH, fullName: 'Ich Selbst' },
              { id: A, fullName: 'Person A' },
              { id: B, fullName: 'Person B' },
            ],
      ),
      findUnique: vi.fn(async () => ({ fullName: 'Admin Mustermann' })),
    },
    clientReminder: {
      create: vi.fn(async () => ({ id: 'neu-1' })),
      findUnique: vi.fn(async () => ({
        clientId: 'client-1',
        subject: 'Recherche Kassenführung',
        notes: 'Auftragstext',
        priority: 'HIGH',
        createdByStaff: ICH,
        assignees: [{ staffId: A }, { staffId: B }],
      })),
    },
    clientReminderNote: { create: vi.fn(async () => ({ id: 'note-1' })) },
    clientReminderAssignee: {
      findMany: vi.fn(async (): Promise<Array<{ staffId: string }>> => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    client: { findUnique: vi.fn(async () => ({ name: 'Muster GmbH' })) },
    ...over,
  };
}

const BASIS = {
  tenantId: TENANT,
  createdByStaff: ICH,
  clientId: 'client-1' as string | null,
  dueDate: new Date('2026-09-01'),
  subject: 'Test',
  notes: null,
  priority: 'NORMAL' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('Benachrichtigung bei Zuweisung', () => {
  it('informiert die Zuständigen — sonst erfahren sie erst am nächsten Tag davon', async () => {
    // Ohne diese Meldung blieb eine frisch delegierte Aufgabe bis zum
    // taeglichen Faelligkeits-Job unbemerkt; und weil die Live-Aktualisierung
    // an der Glocke haengt, tat sich beim Empfaenger auch in der Anzeige nichts.
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [A, B] });

    const empfaenger = notifyMock.mock.calls.map((c) => (c[1] as { staffId: string }).staffId);
    expect(empfaenger.sort()).toEqual([A, B].sort());
    const erste = notifyMock.mock.calls[0]![1] as { kind: string; href: string };
    expect(erste.kind).toBe('CLIENT_REMINDER_ASSIGNED');
    expect(erste.href).toBe('/staff/reminders/neu-1');
  });

  it('schickt bei Selbst-Zuweisung nichts', async () => {
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [ICH] });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('lässt die anlegende Person aus, wenn sie mit auf der Liste steht', async () => {
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [ICH, A] });

    const empfaenger = notifyMock.mock.calls.map((c) => (c[1] as { staffId: string }).staffId);
    expect(empfaenger).toEqual([A]);
  });

  it('informiert beim Umverteilen nur die NEU Hinzugekommenen', async () => {
    const tx = makeTx();
    tx.clientReminderAssignee.findMany = vi.fn(async () => [{ staffId: A }]);
    tx.clientReminder.findUnique = vi.fn(async () => ({
      clientId: 'client-1',
      subject: 'Belege',
      dueDate: new Date('2026-09-01'),
    })) as never;

    await setReminderAssigneesTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffIds: [A, B],
      von: ICH,
    });

    const empfaenger = notifyMock.mock.calls.map((c) => (c[1] as { staffId: string }).staffId);
    expect(empfaenger).toEqual([B]);
  });
});

describe('createReminderTx', () => {
  it('legt mehrere Zuständige an — EINE Aufgabe', async () => {
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [A, B] });

    const data = letzteCreateData(tx.clientReminder.create);
    expect(data.assignees?.create).toEqual([{ staffId: A }, { staffId: B }]);
  });

  it('macht die anlegende Person zuständig, wenn niemand gewählt wurde', async () => {
    // Sonst entstuende eine herrenlose Aufgabe, die in keiner Liste auftaucht.
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [] });

    expect(letzteCreateData(tx.clientReminder.create).assignees?.create).toEqual([
      { staffId: ICH },
    ]);
  });

  it('entdoppelt die Auswahl', async () => {
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [A, A, B] });

    expect(letzteCreateData(tx.clientReminder.create).assignees?.create).toEqual([
      { staffId: A },
      { staffId: B },
    ]);
  });

  it('erlaubt eine interne Aufgabe ohne Mandanten', async () => {
    const tx = makeTx();
    await createReminderTx(tx as never, { ...BASIS, clientId: null, assigneeStaffIds: [A] });

    expect(letzteCreateData(tx.clientReminder.create).clientId).toBeNull();
  });

  it('weist unbekannte oder inaktive Zuständige ab', async () => {
    // Sonst entstuende eine haengende Zuweisung an eine fremde Staff-ID.
    const tx = makeTx({ staffUser: { findMany: vi.fn(async () => [{ id: A }]) } });

    await expect(
      createReminderTx(tx as never, { ...BASIS, assigneeStaffIds: [A, 'fremd'] }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(tx.clientReminder.create).not.toHaveBeenCalled();
  });
});

describe('cloneReminderTx', () => {
  it('übernimmt beim Klonen Inhalt und Zuständige, ohne Verkettung', async () => {
    const tx = makeTx();
    await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: ICH },
      { alsNachfrage: false, dueDate: new Date('2026-10-01') },
    );

    const data = letzteCreateData(tx.clientReminder.create);
    expect(data.subject).toBe('Recherche Kassenführung');
    expect(data.priority).toBe('HIGH');
    expect(data.assignees?.create).toEqual([{ staffId: A }, { staffId: B }]);
    expect(data.predecessorId).toBeNull();
  });

  it('verkettet beim Nachfassen und benennt die Folgestufe', async () => {
    const tx = makeTx();
    await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: ICH },
      { alsNachfrage: true, dueDate: new Date('2026-10-01') },
    );

    const data = letzteCreateData(tx.clientReminder.create);
    expect(data.predecessorId).toBe('quelle-1');
    expect(data.subject).toBe('Nachfrage zu: Recherche Kassenführung');
  });

  it('erlaubt beim Nachfassen andere Zuständige und Frist', async () => {
    const tx = makeTx();
    await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: ICH },
      { alsNachfrage: true, dueDate: new Date('2026-10-01'), assigneeStaffIds: [A] },
    );

    expect(letzteCreateData(tx.clientReminder.create).assignees?.create).toEqual([{ staffId: A }]);
  });
});

describe('nachfrageTitel', () => {
  it('zählt statt zu schachteln', () => {
    // „Nachfrage zu: Nachfrage zu: Nachfrage zu: …" waere unlesbar.
    const eins = nachfrageTitel('Recherche X');
    const zwei = nachfrageTitel(eins);
    const drei = nachfrageTitel(zwei);
    expect(eins).toBe('Nachfrage zu: Recherche X');
    expect(zwei).toBe('Nachfrage 2 zu: Recherche X');
    expect(drei).toBe('Nachfrage 3 zu: Recherche X');
  });
});

describe('addReminderNoteTx', () => {
  it('speichert getrimmt', async () => {
    const tx = makeTx();
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: '  Wie ist der Stand?  ',
    });
    expect(letzteCreateData(tx.clientReminderNote.create).body).toBe('Wie ist der Stand?');
  });

  it('weist leere Wortmeldungen ab', async () => {
    const tx = makeTx();
    await expect(
      addReminderNoteTx(tx as never, {
        tenantId: TENANT,
        reminderId: 'r1',
        staffId: ICH,
        body: '   ',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe('setReminderAssigneesTx', () => {
  it('entfernt Abgewählte und ergänzt Neue', async () => {
    const tx = makeTx();
    await setReminderAssigneesTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffIds: [A, ICH],
    });

    expect(tx.clientReminderAssignee.deleteMany).toHaveBeenCalledWith({
      where: { reminderId: 'r1', staffId: { notIn: [A, ICH] } },
    });
    expect(tx.clientReminderAssignee.createMany).toHaveBeenCalledWith({
      data: [
        { reminderId: 'r1', staffId: A },
        { reminderId: 'r1', staffId: ICH },
      ],
      skipDuplicates: true,
    });
  });

  it('lässt die Aufgabe nicht ohne Zuständige zurück', async () => {
    const tx = makeTx();
    await expect(
      setReminderAssigneesTx(tx as never, { tenantId: TENANT, reminderId: 'r1', staffIds: [] }),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe('Rückkanal: Wortmeldung und Nachfassen', () => {
  it('Wortmeldung informiert alle Beteiligten ausser der schreibenden Person', async () => {
    // Der gemeldete Fall: die Mitarbeiterin fragt nach — und die delegierende
    // Person erfuhr nichts davon, bis sie zufaellig vorbeischaute.
    const tx = makeTx();
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: A,
      body: 'Wie ist der Stand?',
    });

    const meldungen = notifyMock.mock.calls.map(
      (c) => c[1] as { staffId: string; kind: string; href: string; resourceId: string },
    );
    // Beteiligte der Aufgabe: ICH (angelegt), A + B (zugewiesen). A schreibt.
    expect(meldungen.map((m) => m.staffId).sort()).toEqual([B, ICH].sort());
    expect(meldungen[0]!.kind).toBe('CLIENT_REMINDER_NOTE');
    expect(meldungen[0]!.href).toBe('/staff/reminders/r1');
    // Die NOTE-ID als resource: mit der Wiedervorlage als resource kollabierte
    // der Dedupe-Upsert jede weitere Nachricht in die bestehende ungelesene
    // Meldung — nur die erste war hoerbar.
    expect(meldungen[0]!.resourceId).toBe('note-1');
  });

  it('Upload informiert die Beteiligten ausser der hochladenden Person', async () => {
    const tx = makeTx();
    tx.clientReminder.findUnique = vi.fn(async () => ({
      subject: 'Belege 2025',
      createdByStaff: ICH,
      assignees: [{ staffId: A }, { staffId: B }],
    })) as never;

    await notifyReminderAttachmentTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      documentId: 'doc-1',
      documentTitle: 'Kontoauszug_Q3.pdf',
      uploadedBy: A,
    });

    const meldungen = notifyMock.mock.calls.map(
      (c) => c[1] as { staffId: string; kind: string; resourceId: string },
    );
    expect(meldungen.map((m) => m.staffId).sort()).toEqual([B, ICH].sort());
    expect(meldungen[0]!.kind).toBe('CLIENT_REMINDER_ATTACHMENT');
    // Jeder Upload ist eine eigene Meldung (Dokument-ID als resource).
    expect(meldungen[0]!.resourceId).toBe('doc-1');
  });

  it('Nachfassen informiert die Beteiligten der Ursprungsstufe — ohne Doppelmeldung', async () => {
    // A fasst nach und bleibt selbst zustaendig: B (bisher zustaendig) und ICH
    // (delegierend) muessen es erfahren; A selbst nicht, und die neuen
    // Zustaendigen bekommen bereits CLIENT_REMINDER_ASSIGNED.
    const tx = makeTx();
    await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: A },
      { alsNachfrage: true, dueDate: new Date('2026-10-01'), assigneeStaffIds: [A] },
    );

    const followups = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string; kind: string })
      .filter((m) => m.kind === 'CLIENT_REMINDER_FOLLOWUP');
    expect(followups.map((m) => m.staffId).sort()).toEqual([B, ICH].sort());
  });

  it('Klonen (ohne Nachfrage) erzeugt keine Followup-Meldung', async () => {
    const tx = makeTx();
    await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: ICH },
      { alsNachfrage: false, dueDate: new Date('2026-10-01') },
    );

    const kinds = notifyMock.mock.calls.map((c) => (c[1] as { kind: string }).kind);
    expect(kinds).not.toContain('CLIENT_REMINDER_FOLLOWUP');
  });

  it('Nachfassen auf ERLEDIGTER Stufe braucht kein Wiederöffnen', async () => {
    // Genau der gemeldete Zwang: die Quelle darf erledigt bleiben — die
    // Folgestufe ist eine eigene, offene Aufgabe.
    const tx = makeTx();
    tx.clientReminder.findUnique = vi.fn(async () => ({
      clientId: 'client-1',
      subject: 'Recherche Kassenführung',
      notes: null,
      priority: 'NORMAL',
      createdByStaff: ICH,
      doneAt: new Date('2026-08-01'),
      assignees: [{ staffId: A }],
    })) as never;

    const neu = await cloneReminderTx(
      tx as never,
      'quelle-1',
      { tenantId: TENANT, staffId: ICH },
      { alsNachfrage: true, dueDate: new Date('2026-10-01') },
    );
    expect(neu.id).toBe('neu-1');
    // Kein update auf der Quelle — sie bleibt erledigt.
    expect((tx.clientReminder as { update?: unknown }).update).toBeUndefined();
  });
});

describe('@-Erwähnungen und Benachrichtigungs-Modus', () => {
  it('erwähnte Person bekommt MENTION statt NOTE — kein Doppel', async () => {
    const tx = makeTx();
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: '@Person A kannst du das übernehmen?',
    });

    const anA = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string; kind: string })
      .filter((m) => m.staffId === A);
    expect(anA.map((m) => m.kind)).toEqual(['CLIENT_REMINDER_MENTION']);
    // B ist beteiligt, aber nicht erwähnt → normale NOTE.
    const anB = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string; kind: string })
      .filter((m) => m.staffId === B);
    expect(anB.map((m) => m.kind)).toEqual(['CLIENT_REMINDER_NOTE']);
  });

  it('MENTIONS_ONLY schaltet den laufenden Austausch stumm — die Erwähnung nicht', async () => {
    const tx = makeTx();
    // Modus-Filter: nur B steht noch auf ALL, A hat auf MENTIONS_ONLY gestellt.
    const findMany = tx.staffUser.findMany;
    tx.staffUser.findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
      if ('reminderNotifyMode' in args.where) return [{ id: B }];
      return findMany(args as never);
    }) as never;

    // Ohne Erwähnung: A bleibt stumm, B bekommt die NOTE.
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: 'Zwischenstand ohne Ansprache.',
    });
    const ohne = notifyMock.mock.calls.map((c) => c[1] as { staffId: string });
    expect(ohne.map((m) => m.staffId)).toEqual([B]);

    notifyMock.mockClear();
    // MIT Erwähnung: A wird trotzdem erreicht — wer @-genannt wird, ist gemeint.
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: '@Person A bitte direkt anschauen.',
    });
    const mit = notifyMock.mock.calls.map((c) => c[1] as { staffId: string; kind: string });
    expect(mit.find((m) => m.staffId === A)?.kind).toBe('CLIENT_REMINDER_MENTION');
  });

  it('erwähnte Unbeteiligte ohne Zugriff bekommen nichts (interne Aufgabe)', async () => {
    const tx = makeTx();
    // Interne Aufgabe (kein Mandant) — Zugriff nur fuer Beteiligte.
    tx.clientReminder.findUnique = vi.fn(async () => ({
      clientId: null,
      subject: 'Interna',
      createdByStaff: ICH,
      assignees: [],
    })) as never;

    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: '@Person A schau mal (darfst du aber nicht).',
    });

    const anA = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string })
      .filter((m) => m.staffId === A);
    expect(anA).toEqual([]);
  });

  it('erwähnte Unbeteiligte MIT Mandantenzugriff werden erreicht', async () => {
    const tx = makeTx();
    tx.clientReminder.findUnique = vi.fn(async () => ({
      clientId: 'client-1',
      subject: 'Belege',
      createdByStaff: ICH,
      assignees: [],
    })) as never;
    canAccessMock.mockResolvedValue(true);

    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: ICH,
      body: '@Person A bitte übernehmen.',
    });

    expect(canAccessMock).toHaveBeenCalledWith(expect.anything(), TENANT, A, 'client-1');
    const anA = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string; kind: string })
      .filter((m) => m.staffId === A);
    expect(anA.map((m) => m.kind)).toEqual(['CLIENT_REMINDER_MENTION']);
  });

  it('wer sich selbst erwähnt, bekommt keine Meldung', async () => {
    const tx = makeTx();
    await addReminderNoteTx(tx as never, {
      tenantId: TENANT,
      reminderId: 'r1',
      staffId: A,
      body: 'Notiz von @Person A an sich selbst.',
    });
    const anA = notifyMock.mock.calls
      .map((c) => c[1] as { staffId: string })
      .filter((m) => m.staffId === A);
    expect(anA).toEqual([]);
  });
});
