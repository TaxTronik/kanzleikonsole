import { describe, expect, it } from 'vitest';
import { phoneNoteReminderStatus } from '../phone-note-reminder-status';

describe('Telefonnotiz-Wiedervorlagenstatus', () => {
  const today = '2026-08-23';

  it('stellt erledigt unabhängig von der Fälligkeit an erster Stelle fest', () => {
    expect(
      phoneNoteReminderStatus(
        { dueDate: '2026-08-20T00:00:00.000Z', doneAt: '2026-08-21T08:00:00.000Z' },
        today,
      ),
    ).toBe('DONE');
  });

  it('unterscheidet überfällig, heute fällig und künftig offen kalendertagsgenau', () => {
    expect(phoneNoteReminderStatus({ dueDate: '2026-08-22', doneAt: null }, today)).toBe('OVERDUE');
    expect(phoneNoteReminderStatus({ dueDate: '2026-08-23', doneAt: null }, today)).toBe(
      'DUE_TODAY',
    );
    expect(phoneNoteReminderStatus({ dueDate: '2026-08-24', doneAt: null }, today)).toBe('OPEN');
  });
});
