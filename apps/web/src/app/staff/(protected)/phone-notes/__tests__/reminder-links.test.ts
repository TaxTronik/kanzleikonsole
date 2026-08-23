import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const protectedRoot = resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(resolve(protectedRoot, relative), 'utf8');

describe('Wiedervorlagen an Telefonnotizen', () => {
  it('lädt die Relation in globaler Liste und Mandanten-Cockpit', () => {
    const globalPage = read('phone-notes/page.tsx');
    const clientData = read('clients/[id]/_data.ts');
    const clientPage = read('clients/[id]/page.tsx');

    expect(globalPage).toContain('reminders: {');
    expect(globalPage).toContain('reminders: n.reminders.map');
    expect(clientData).toContain('reminders: {');
    expect(clientPage).toContain('reminders: p.reminders.map');
  });

  it('zeigt Link, Status und Fälligkeit auch bei erledigten Telefonnotizen', () => {
    const list = read('clients/[id]/phone-notes-list.tsx');

    expect(list).toContain('href={`/staff/reminders/${reminder.id}`}');
    expect(list).toContain("OVERDUE: { label: 'Überfällig'");
    expect(list).toContain("DONE: { label: 'Erledigt'");
    expect(list).toContain('{status.label} · fällig');
    expect(list.match(/<PhoneNoteReminderLinks/g)).toHaveLength(2);
  });
});
