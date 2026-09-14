import { describe, expect, it, vi } from 'vitest';
import { loadWorkBasket, workBasketBucket, WORK_BASKET_SOURCE_SLOTS } from '../basket';

describe('PORTAL-INBOX-SUBMISSION-001: Arbeitskorb', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('gruppiert Faelligkeiten am Berlin-Kalendertag', () => {
    expect(
      workBasketBucket({ kind: 'workflow', dueAt: new Date('2026-08-31T00:00:00.000Z') }, now),
    ).toBe('overdue');
    expect(
      workBasketBucket({ kind: 'reminder', dueAt: new Date('2026-09-01T00:00:00.000Z') }, now),
    ).toBe('today');
    expect(
      workBasketBucket(
        { kind: 'appointment', startsAt: new Date('2026-09-02T08:00:00.000Z') },
        now,
      ),
    ).toBe('later');
    expect(
      workBasketBucket(
        { kind: 'appointment', startsAt: new Date('2026-08-31T12:00:00.000Z') },
        now,
      ),
    ).toBe('overdue');
    expect(workBasketBucket({ kind: 'portal-inbox' }, now)).toBe('undated');
  });

  it('bleibt am Berliner DST-Wechseltag kalendertagsstabil', () => {
    const dstNow = new Date('2026-10-25T22:30:00.000Z'); // 23:30 Uhr Europe/Berlin
    expect(
      workBasketBucket({ kind: 'reminder', dueAt: new Date('2026-10-25T12:00:00.000Z') }, dstNow),
    ).toBe('today');
    expect(
      workBasketBucket({ kind: 'workflow', dueAt: new Date('2026-10-26T12:00:00.000Z') }, dstNow),
    ).toBe('later');
  });

  it('haelt portal-inbox fuer Meine- und Team-Slots erweiterbar', async () => {
    expect(WORK_BASKET_SOURCE_SLOTS['portal-inbox']).toEqual(['mine', 'team']);
    const load = vi.fn().mockResolvedValue([
      {
        key: 'portal-inbox:1',
        kind: 'portal-inbox',
        slot: 'team',
        title: 'Neue Nachricht',
        context: 'Muster GmbH',
        href: '/staff/inbox/1',
        bucket: 'undated',
        sortAt: now,
        occurredAt: now,
        sourceId: '1',
      },
    ]);
    const result = await loadWorkBasket({
      tx: {} as never,
      staffId: 'staff-1',
      now,
      slot: 'team',
      sources: { workflows: false, reminders: false, appointments: false, phoneNotes: false },
      extensions: [{ kind: 'portal-inbox', slots: ['mine', 'team'], load }],
    });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ slot: 'team' }));
    expect(result.map((item) => item.kind)).toEqual(['portal-inbox']);
  });

  it.each([1, 20, 100, 200])(
    'priorisiert faellige Quellen vor %i aelteren Telefonzetteln und begrenzt erst danach',
    async (limit) => {
      const phoneNotes = Array.from({ length: 250 }, (_, index) => ({
        id: `phone-${index}`,
        subject: `Telefonzettel ${index}`,
        callerName: 'Anrufer',
        client: null,
        createdAt: new Date(Date.UTC(2026, 6, 1, 0, index)),
      }));
      const tx = {
        workflowItem: {
          findMany: vi.fn(async ({ take }: { take: number }) =>
            [
              {
                id: 'urgent-workflow',
                title: 'Überfällige Erklärung',
                dueDate: new Date('2026-08-31T00:00:00Z'),
                instance: {
                  clientId: 'client',
                  name: 'Steuererklärung',
                  client: { name: 'Mandat' },
                },
              },
            ].slice(0, take),
          ),
        },
        clientReminder: {
          findMany: vi.fn(async ({ take }: { take: number }) =>
            [
              {
                id: 'today-reminder',
                subject: 'Heute fällige Rückfrage',
                dueDate: new Date('2026-09-01T00:00:00Z'),
                client: null,
              },
            ].slice(0, take),
          ),
        },
        appointment: {
          findMany: vi.fn(async ({ take }: { take: number }) =>
            [
              {
                id: 'later-appointment',
                title: 'Morgiger Termin',
                startsAt: new Date('2026-09-02T08:00:00Z'),
                endsAt: new Date('2026-09-02T09:00:00Z'),
                location: null,
                client: null,
              },
            ].slice(0, take),
          ),
        },
        phoneNote: {
          findMany: vi.fn(async ({ take }: { take: number }) => phoneNotes.slice(0, take)),
        },
      };

      const result = await loadWorkBasket({
        tx: tx as never,
        staffId: 'staff-1',
        deniedClientIds: ['restricted-client'],
        now,
        sources: { workflows: true, reminders: true, appointments: true, phoneNotes: true },
        limit,
      });

      expect(result).toHaveLength(limit);
      expect(result.slice(0, Math.min(limit, 3)).map((entry) => entry.bucket)).toEqual(
        ['overdue', 'today', 'later'].slice(0, limit),
      );
      expect(result[0]?.sourceId).toBe('urgent-workflow');
      for (const source of Object.values(tx)) {
        expect(source.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: limit }));
      }
    },
  );
});
