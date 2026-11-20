// Fachkatalog: REMINDER-TICKET-001
// Fachkatalog: TAX-CONTROL-STATUS-001
// Fachkatalog: WORKFLOW-LIFECYCLE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBinderAction } from '@/app/staff/(protected)/clients/[id]/binders/actions';
import {
  cloneReminderAction,
  createReminderAction,
} from '@/app/staff/(protected)/clients/[id]/reminders/actions';
import {
  addItemToInstanceAction,
  pauseInstanceAction,
  setItemDueDateAction,
} from '@/app/staff/(protected)/clients/[id]/workflows/actions';
import { phoneNoteToReminderAction } from '@/app/staff/(protected)/phone-notes/actions';

const { gatedOperation } = vi.hoisted(() => ({ gatedOperation: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class extends Error {},
  withStaffModule: () => gatedOperation,
  staffActionGuard: gatedOperation,
}));
vi.mock('@/server/auth/rbac', () => ({}));
vi.mock('@/server/container', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const id = '11111111-1111-4111-8111-111111111111';
const cases: [string, (day: string) => Promise<{ ok: boolean }>][] = [
  [
    'neue Wiedervorlage',
    (day) => {
      const form = new FormData();
      form.set('subject', 'Rückruf');
      form.set('dueDate', day);
      form.set('assigneeStaffIds', id);
      return createReminderAction(null, form);
    },
  ],
  [
    'kopierte Wiedervorlage',
    (day) => cloneReminderAction({ id, alsNachfrage: true, dueDate: day }),
  ],
  ['Telefonnotiz als Wiedervorlage', (day) => phoneNoteToReminderAction({ id, dueDate: day })],
  [
    'Pendelordner',
    (day) => {
      const form = new FormData();
      form.set('clientId', id);
      form.set('label', 'Kassenbelege');
      form.set('expectedReturnAt', day);
      return createBinderAction(null, form);
    },
  ],
  ['Schritt ändern', (day) => setItemDueDateAction({ id, dueDate: day })],
  [
    'Schritt anlegen',
    (day) => addItemToInstanceAction({ instanceId: id, title: 'Rückruf', dueDate: day }),
  ],
  [
    'Workflow pausieren',
    (day) => pauseInstanceAction({ instanceId: id, reason: 'Urlaub', until: day }),
  ],
];

describe('Kalendertage aus manueller Eingabe', () => {
  beforeEach(() => {
    gatedOperation
      .mockReset()
      .mockResolvedValue({ ok: false, error: 'Test der Eingabe abgeschlossen.' });
  });

  it.each(cases)('%s unterscheidet den Schalttag von unmöglichen Daten', async (_title, run) => {
    for (const invalid of ['2026-02-29', '2024-04-31']) {
      expect((await run(invalid)).ok).toBe(false);
    }
    expect(gatedOperation).not.toHaveBeenCalled();
    await run('2024-02-29');
    expect(gatedOperation).toHaveBeenCalledOnce();
  });
});
