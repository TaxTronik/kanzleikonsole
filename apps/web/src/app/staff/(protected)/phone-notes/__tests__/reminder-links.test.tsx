// Wiedervorlagen an Telefonnotizen: gerenderte Links, Status und Fälligkeit in
// der globalen Liste und im Mandanten-Cockpit (statt Quelltextprüfung).

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtDateShort } from '@/lib/fmt';

const h = vi.hoisted(() => ({
  tx: {
    phoneNote: { findMany: vi.fn() },
    staffUser: { findMany: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/staff/(protected)/phone-notes/actions', () => ({
  markPhoneNoteDoneAction: vi.fn(),
  undoPhoneNoteDoneAction: vi.fn(),
  forwardPhoneNoteAction: vi.fn(),
  phoneNoteToReminderAction: vi.fn(),
}));
vi.mock('@/components/ui/modal', () => ({ noticeDialog: vi.fn() }));
vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/rbac', () => ({ accessibleClientsWhereFor: vi.fn(async () => ({})) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, callback: (tx: typeof h.tx) => unknown) =>
    callback(h.tx),
  ),
}));
vi.mock('../new-form', () => ({ NewPhoneNoteForm: () => null }));
vi.mock('@/app/staff/(protected)/clients/[id]/quick-phone-note', () => ({
  QuickPhoneNote: () => null,
}));

import PhoneNotesPage from '../page';
import { PhoneNotesList, type PhoneNoteItem } from '../../clients/[id]/phone-notes-list';
import { PhoneNotesCockpitBlock } from '../../clients/[id]/cockpit-blocks';

const TODAY = '2026-10-06';

function note(overrides: Partial<PhoneNoteItem>): PhoneNoteItem {
  return {
    id: 'note-open',
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

function due(iso: string): string {
  return fmtDateShort(new Date(iso));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Wiedervorlagen an Telefonnotizen', () => {
  it('zeigt Link, Status und Fälligkeit bei offenen und erledigten Telefonnotizen', () => {
    const html = renderToStaticMarkup(
      <PhoneNotesList
        currentStaffId="staff-1"
        staffOptions={[]}
        todayYmd={TODAY}
        notes={[
          note({
            reminders: [
              {
                id: 'rem-overdue',
                subject: 'Belege anfordern',
                dueDate: '2026-10-01T00:00:00.000Z',
                doneAt: null,
              },
              {
                id: 'rem-done',
                subject: 'Termin bestätigen',
                dueDate: '2026-09-20T00:00:00.000Z',
                doneAt: '2026-09-21T09:00:00.000Z',
              },
            ],
          }),
          note({
            id: 'note-done',
            subject: 'Frage zur Lohnabrechnung',
            doneAt: '2026-10-02T10:00:00.000Z',
            readAt: '2026-10-02T10:00:00.000Z',
            reminders: [
              {
                id: 'rem-today',
                subject: 'Lohnkonto prüfen',
                dueDate: '2026-10-06T00:00:00.000Z',
                doneAt: null,
              },
            ],
          }),
        ]}
      />,
    );

    expect(html).toContain('href="/staff/reminders/rem-overdue"');
    expect(html).toContain(`Überfällig · fällig ${due('2026-10-01T00:00:00.000Z')}`);
    expect(html).toContain('href="/staff/reminders/rem-done"');
    expect(html).toContain(`Erledigt · fällig ${due('2026-09-20T00:00:00.000Z')}`);
    // Auch die eingeklappte Liste der erledigten Notizen verlinkt ihre Wiedervorlagen.
    const doneSection = html.slice(html.indexOf('<details'));
    expect(doneSection).toContain('Frage zur Lohnabrechnung');
    expect(doneSection).toContain('href="/staff/reminders/rem-today"');
    expect(doneSection).toContain(`Heute fällig · fällig ${due('2026-10-06T00:00:00.000Z')}`);
  });

  it('lädt die Wiedervorlagen in der globalen Telefonzettel-Liste und zeigt sie an', async () => {
    h.tx.phoneNote.findMany
      .mockResolvedValueOnce([
        {
          id: 'note-1',
          subject: 'Rückruf Umsatzsteuer',
          callerName: 'Erika Muster',
          callerPhone: null,
          body: 'Bitte zurückrufen.',
          forwardToStaff: null,
          doneAt: null,
          readAt: null,
          createdAt: new Date('2026-10-01T08:00:00.000Z'),
          takenByStaff: 'staff-1',
          clientId: 'client-1',
          client: { id: 'client-1', name: 'Muster GmbH' },
          reminders: [
            {
              id: 'rem-1',
              subject: 'Belege anfordern',
              dueDate: new Date('2099-01-15T00:00:00.000Z'),
              doneAt: null,
            },
          ],
        },
      ])
      .mockResolvedValueOnce([]);
    h.tx.staffUser.findMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await PhoneNotesPage());

    expect(h.tx.phoneNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          reminders: expect.objectContaining({
            select: { id: true, subject: true, dueDate: true, doneAt: true },
          }),
        }),
      }),
    );
    expect(html).toContain('href="/staff/reminders/rem-1"');
    expect(html).toContain(`Offen · fällig ${due('2099-01-15T00:00:00.000Z')}`);
  });

  it('reicht die Wiedervorlagen im Mandanten-Cockpit an die Telefonzettel-Liste weiter', async () => {
    const html = renderToStaticMarkup(
      <>
        {await PhoneNotesCockpitBlock({
          data: Promise.resolve({
            staffList: [],
            phoneNotes: [
              {
                id: 'note-2',
                subject: 'Frage zur Lohnabrechnung',
                callerName: 'Max Muster',
                callerPhone: null,
                body: 'Rückfrage',
                forwardToStaff: null,
                doneAt: new Date('2026-10-02T10:00:00.000Z'),
                readAt: new Date('2026-10-02T10:00:00.000Z'),
                createdAt: new Date('2026-10-01T08:00:00.000Z'),
                takenByStaff: 'staff-1',
                clientId: 'client-1',
                reminders: [
                  {
                    id: 'rem-2',
                    subject: 'Lohnkonto prüfen',
                    dueDate: new Date('2026-09-30T00:00:00.000Z'),
                    doneAt: new Date('2026-10-01T00:00:00.000Z'),
                  },
                ],
              },
            ],
          } as never),
          clientId: 'client-1',
          contacts: [],
          staffId: 'staff-1',
        })}
      </>,
    );

    expect(html).toContain('href="/staff/reminders/rem-2"');
    expect(html).toContain(`Erledigt · fällig ${due('2026-09-30T00:00:00.000Z')}`);
  });
});
