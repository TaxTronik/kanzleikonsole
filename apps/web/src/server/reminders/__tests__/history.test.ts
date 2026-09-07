import { describe, expect, it, vi } from 'vitest';
import { loadReminderHistoryTx, reminderPage } from '../history';

describe('REMINDER-TICKET-001 — vollständige paginierte Ticketgeschichte', () => {
  function fixture() {
    const notes = Array.from({ length: 201 }, (_, i) => ({
      id: `n-${i}`,
      staffId: 'staff',
      body: `Kommentar ${i + 1}`,
      createdAt: new Date(2026, 0, 1, 0, i),
    }));
    const documents = Array.from({ length: 51 }, (_, i) => ({
      id: `d-${i}`,
      ownerStaffId: 'staff',
      title: `Datei ${i + 1}`,
      mimeType: 'text/plain',
      createdAt: new Date(2026, 0, 1, 0, i),
    }));
    const window = <T>(rows: T[], input: { skip: number; take: number }) =>
      [...rows].reverse().slice(input.skip, input.skip + input.take);
    return {
      clientReminderNote: {
        count: vi.fn(async () => notes.length),
        findMany: vi.fn(async (input: { skip: number; take: number }) => window(notes, input)),
      },
      document: {
        count: vi.fn(async () => documents.length),
        findMany: vi.fn(async (input: { skip: number; take: number }) => window(documents, input)),
      },
    };
  }

  it('zeigt Kommentar201 und Anhang51 auf der neuesten Seite und bewahrt ältere Seiten', async () => {
    const tx = fixture();
    const latest = await loadReminderHistoryTx(tx as never, 'tenant', 'ticket', {});
    expect(latest.discussion).toHaveLength(200);
    expect(latest.discussion[0]?.body).toBe('Kommentar 2');
    expect(latest.discussion.at(-1)?.body).toBe('Kommentar 201');
    expect(latest.attachments).toHaveLength(50);
    expect(latest.attachments.at(-1)?.title).toBe('Datei 51');
    expect(latest.pagination).toEqual({
      commentsPage: 1,
      commentsTotal: 201,
      commentsPageSize: 200,
      attachmentsPage: 1,
      attachmentsTotal: 51,
      attachmentsPageSize: 50,
    });
    const older = await loadReminderHistoryTx(tx as never, 'tenant', 'ticket', {
      commentsPage: 2,
      attachmentsPage: 2,
    });
    expect(older.discussion.map((note) => note.body)).toEqual(['Kommentar 1']);
    expect(older.attachments.map((document) => document.title)).toEqual(['Datei 1']);
    expect(new Set([...latest.discussion, ...older.discussion].map((note) => note.id)).size).toBe(
      201,
    );
  });

  it('klemmt beide Seitennummern unabhängig und bindet alle Reads an Ticket/Tenant', async () => {
    const tx = fixture();
    const result = await loadReminderHistoryTx(tx as never, 'tenant', 'ticket', {
      commentsPage: -1,
      attachmentsPage: 999,
    });
    expect(result.pagination.commentsPage).toBe(1);
    expect(result.pagination.attachmentsPage).toBe(2);
    expect(tx.clientReminderNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant', reminderId: 'ticket' },
        skip: 0,
        take: 200,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(tx.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant', reminderId: 'ticket', deletedAt: null },
        skip: 50,
        take: 50,
      }),
    );
  });

  it.each([undefined, NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'normalisiert ungültige Seiten %s auf1',
    (page) => {
      expect(reminderPage(page, 201, 200)).toBe(1);
    },
  );

  it('liefert auch für leere Geschichte Seite1', () => {
    expect(reminderPage(999, 0, 200)).toBe(1);
  });
});
