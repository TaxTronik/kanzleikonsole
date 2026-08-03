import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Anlegen / Klonen / Nachfassen — mehrere Zuständige, optionaler Mandant.
// =============================================================================

vi.mock('@/server/actions/staff-action', () => {
  class ActionError extends Error {}
  return { ActionError };
});

import { ActionError } from '@/server/actions/staff-action';
import {
  addReminderNoteTx,
  cloneReminderTx,
  createReminderTx,
  nachfrageTitel,
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
      // Standard: jede angefragte ID ist gültig.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id })),
      ),
    },
    clientReminder: {
      create: vi.fn(async () => ({ id: 'neu-1' })),
      findUnique: vi.fn(async () => ({
        clientId: 'client-1',
        subject: 'Recherche Kassenführung',
        notes: 'Auftragstext',
        priority: 'HIGH',
        assignees: [{ staffId: A }, { staffId: B }],
      })),
    },
    clientReminderNote: { create: vi.fn(async () => ({ id: 'note-1' })) },
    clientReminderAssignee: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
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
