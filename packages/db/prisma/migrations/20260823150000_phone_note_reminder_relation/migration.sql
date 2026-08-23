-- Optionale, belastbare Herkunftsrelation fuer Wiedervorlagen aus
-- Telefonnotizen. Bewusst KEIN Unique-Constraint: eine Notiz kann mehrere
-- eigenstaendige Sachverhalte und damit mehrere Wiedervorlagen enthalten.
ALTER TABLE "client_reminder"
  ADD COLUMN "phone_note_id" UUID;

ALTER TABLE "client_reminder"
  ADD CONSTRAINT "client_reminder_phone_note_fk"
  FOREIGN KEY ("phone_note_id") REFERENCES "phone_note"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX "client_reminder_phone_note_idx"
  ON "client_reminder" ("phone_note_id");
