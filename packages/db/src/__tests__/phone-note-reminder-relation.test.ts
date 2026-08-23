import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823150000_phone_note_reminder_relation/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Telefonnotiz → mehrere Wiedervorlagen', () => {
  it('modelliert eine optionale Herkunft mit Rückrelation und Index', () => {
    expect(schema).toContain(
      'phoneNoteId    String?                  @map("phone_note_id") @db.Uuid',
    );
    expect(schema).toContain('@relation("PhoneNoteReminders"');
    expect(schema).toContain('reminders      ClientReminder[] @relation("PhoneNoteReminders")');
    expect(schema).toContain('@@index([phoneNoteId], map: "client_reminder_phone_note_idx")');
  });

  it('sichert die Relation per FK ab, erhält Wiedervorlagen beim Löschen und erlaubt 1:n', () => {
    expect(migration).toContain('ADD COLUMN "phone_note_id" UUID');
    expect(migration).toContain('CONSTRAINT "client_reminder_phone_note_fk"');
    expect(migration).toContain('REFERENCES "phone_note"("id")');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE NO ACTION');
    expect(migration).toContain('CREATE INDEX "client_reminder_phone_note_idx"');
    expect(migration).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[^;]*phone_note_id/is);
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*"phone_note_id"\s*\)/i);
  });
});
