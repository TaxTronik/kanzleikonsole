-- Iter. 35 — Telefonzettel-Lifecycle
--
-- Bisher gab es nur readAt (= "gesehen"). Aber "gesehen" != "erledigt" —
-- ein Mitarbeiter sieht den Zettel, ruft aber erst später zurück. Ohne
-- doneAt-Markierung wuchs die Liste endlos und niemand wusste, was offen ist.
--
-- doneAt + doneByStaff dokumentieren Rückruf/Erledigung.

ALTER TABLE "phone_note"
  ADD COLUMN "done_at" TIMESTAMPTZ,
  ADD COLUMN "done_by_staff" UUID;

ALTER TABLE "phone_note"
  ADD CONSTRAINT "phone_note_done_by_staff_fkey"
  FOREIGN KEY ("done_by_staff") REFERENCES "staff_user"("id") ON DELETE SET NULL;

CREATE INDEX "phone_note_tenant_done_idx" ON "phone_note"("tenant_id", "done_at");
