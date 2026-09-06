import { describe, expect, it, vi } from 'vitest';
import { loadWorkBasket, workBasketBucket, WORK_BASKET_SOURCE_SLOTS } from '../basket';

describe('Arbeitskorb', () => {
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
});
