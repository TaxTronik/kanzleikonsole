// „Als gelesen markieren“ an Telefonnotizen (Review C1): gerenderte Bedienung
// in globaler Liste und Mandanten-Cockpit, Verdrahtung der markNoteReadAction
// (FormData, Transition, Refresh, Fehlermeldung) und der lokale Lesestatus
// nach Erfolg. Ohne DOM-Testumgebung liefert der statische Render die Handler
// des Anfangszustands (wie n8n-form-hooks.test.tsx).

import type { TransitionStartFunction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  markNoteReadAction: vi.fn(),
  noticeDialog: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/staff/(protected)/phone-notes/actions', () => ({
  markNoteReadAction: h.markNoteReadAction,
  markPhoneNoteDoneAction: vi.fn(),
  undoPhoneNoteDoneAction: vi.fn(),
  forwardPhoneNoteAction: vi.fn(),
  phoneNoteToReminderAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ noticeDialog: h.noticeDialog }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/app/staff/(protected)/clients/[id]/quick-phone-note', () => ({
  QuickPhoneNote: () => null,
}));

import { PhoneNotesList, type PhoneNoteItem } from '../../clients/[id]/phone-notes-list';
import { PhoneNotesCockpitBlock } from '../../clients/[id]/cockpit-blocks';
import {
  createPhoneNoteReadState,
  isPhoneNoteUnread,
  usePhoneNoteReadStatus,
  withNoteMarkedRead,
} from '../read-status';

const TODAY = '2026-10-06';

function note(overrides: Partial<PhoneNoteItem>): PhoneNoteItem {
  return {
    id: 'note-unread',
    subject: 'Rückruf Umsatzsteuer',
    callerName: 'Erika Muster',
    callerPhone: null,
    body: 'Bitte zurückrufen.',
    forwardToStaff: null,
    doneAt: null,
    readAt: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    takenByStaff: 'staff-1',
    clientId: 'client-1',
    client: null,
    reminders: [],
    ...overrides,
  };
}

const NOTES: PhoneNoteItem[] = [
  note({}),
  note({
    id: 'note-read',
    subject: 'Termin Jahresabschluss',
    readAt: '2026-10-02T09:00:00.000Z',
  }),
  note({
    id: 'note-done',
    subject: 'Frage zur Lohnabrechnung',
    doneAt: '2026-10-02T10:00:00.000Z',
    readAt: '2026-10-02T10:00:00.000Z',
  }),
];

/** Öffnende Tags aller Buttons mit „Als gelesen markieren“. */
function markReadButtons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-label="Als gelesen markieren: [^"]*"[^>]*>/g)].map(
    (match) => match[0],
  );
}

let log: string[] = [];
let pending: Promise<unknown>[] = [];

function runtime() {
  const startTransition = vi.fn((callback: () => unknown) => {
    log.push('transition');
    pending.push(Promise.resolve(callback()));
  }) as unknown as TransitionStartFunction;
  return { startTransition, router: { refresh: () => log.push('refresh') } };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.all(pending);
}

/** Rendert den Hook statisch und liefert seine Handler des Anfangszustands. */
function probe<T>(useHook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return value!;
}

beforeEach(() => {
  vi.clearAllMocks();
  log = [];
  pending = [];
  h.markNoteReadAction.mockImplementation(async (previous: unknown, formData: FormData) => {
    log.push(`markNoteReadAction:${JSON.stringify([previous, [...formData.entries()]])}`);
    return { ok: true };
  });
  h.noticeDialog.mockImplementation(async (message: string, options: { title: string }) => {
    log.push(`notice:${options.title}:${message}`);
  });
});

describe('Telefonnotiz als gelesen markieren — Darstellung', () => {
  it('bietet die Bedienung nur an offenen, ungelesenen Notizen mit zugänglichem Namen an', () => {
    const html = renderToStaticMarkup(
      <PhoneNotesList currentStaffId="staff-1" staffOptions={[]} todayYmd={TODAY} notes={NOTES} />,
    );

    const buttons = markReadButtons(html);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('type="button"');
    expect(buttons[0]).toContain('aria-label="Als gelesen markieren: Rückruf Umsatzsteuer"');
    expect(buttons[0]).not.toContain('disabled');
    // Sichtbarer Text = Anfang des zugänglichen Namens (WCAG 2.5.3), Icon dekorativ.
    expect(html).toMatch(
      /aria-label="Als gelesen markieren: Rückruf Umsatzsteuer"[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Als gelesen markieren<\/button>/,
    );
    expect(html.split('>ungelesen<').length - 1).toBe(1);
    expect(html).not.toContain('Als gelesen markieren: Termin Jahresabschluss');
    expect(html).not.toContain('Als gelesen markieren: Frage zur Lohnabrechnung');
  });

  it('zeigt die Bedienung auch im Mandanten-Cockpit', async () => {
    const html = renderToStaticMarkup(
      <>
        {await PhoneNotesCockpitBlock({
          data: Promise.resolve({
            staffList: [],
            phoneNotes: [
              {
                id: 'note-cockpit',
                subject: 'Rückfrage Vorauszahlung',
                callerName: 'Max Muster',
                callerPhone: null,
                body: 'Rückfrage',
                forwardToStaff: 'staff-2',
                doneAt: null,
                readAt: null,
                createdAt: new Date('2026-10-01T08:00:00.000Z'),
                takenByStaff: 'staff-1',
                clientId: 'client-1',
                reminders: [],
              },
            ],
          } as never),
          clientId: 'client-1',
          contacts: [],
          staffId: 'staff-1',
        })}
      </>,
    );

    expect(markReadButtons(html)).toEqual([
      expect.stringContaining('aria-label="Als gelesen markieren: Rückfrage Vorauszahlung"'),
    ]);
  });
});

describe('Telefonnotiz als gelesen markieren — Verdrahtung', () => {
  it('ruft markNoteReadAction mit der Notiz-ID in einer Transition auf und lädt danach neu', async () => {
    const hook = probe(() => usePhoneNoteReadStatus(NOTES, runtime()));
    expect(hook.isUnread(NOTES[0]!)).toBe(true);
    expect(hook.isUnread(NOTES[1]!)).toBe(false);

    hook.markRead('note-unread');
    await settle();

    expect(log).toEqual([
      'transition',
      'markNoteReadAction:[null,[["noteId","note-unread"]]]',
      'refresh',
    ]);
  });

  it('meldet einen Fehler im Dialog und lädt dann nicht neu', async () => {
    h.markNoteReadAction.mockResolvedValue({ ok: false, error: 'Telefonnotiz nicht gefunden.' });
    const hook = probe(() => usePhoneNoteReadStatus(NOTES, runtime()));

    hook.markRead('note-unread');
    await settle();

    expect(log).toEqual([
      'transition',
      'notice:Als gelesen markieren:Telefonnotiz nicht gefunden.',
    ]);
  });
});

describe('Telefonnotiz als gelesen markieren — Lesestatus nach Erfolg', () => {
  it('blendet „ungelesen“ nach Erfolg sofort aus, bis ein neuer Server-Stand kommt', () => {
    const unread = NOTES[0]!;
    const initial = createPhoneNoteReadState(NOTES);
    expect(isPhoneNoteUnread(initial, NOTES, unread)).toBe(true);

    const marked = withNoteMarkedRead(initial, NOTES, unread.id);
    expect(isPhoneNoteUnread(marked, NOTES, unread)).toBe(false);
    // Andere Notizen bleiben unberührt; der Ausgangszustand wird nicht verändert.
    expect(isPhoneNoteUnread(marked, NOTES, note({ id: 'other' }))).toBe(true);
    expect(isPhoneNoteUnread(initial, NOTES, unread)).toBe(true);

    // Neuer Server-Stand (router.refresh): readAt entscheidet wieder — auch wenn
    // eine Weiterleitung den Lesestatus inzwischen zurückgesetzt hat.
    const refreshedRead = [{ ...unread, readAt: '2026-10-06T08:00:00.000Z' }];
    expect(isPhoneNoteUnread(marked, refreshedRead, refreshedRead[0]!)).toBe(false);
    const forwardedAgain = [{ ...unread }];
    expect(isPhoneNoteUnread(marked, forwardedAgain, forwardedAgain[0]!)).toBe(true);

    // Eine weitere Markierung auf neuem Stand verwirft ältere Markierungen.
    const next = withNoteMarkedRead(marked, forwardedAgain, 'note-x');
    expect(next.notes).toBe(forwardedAgain);
    expect([...next.ids]).toEqual(['note-x']);
  });
});
