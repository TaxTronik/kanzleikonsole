-- =============================================================================
-- Wiedervorlagen: mehrere Zuständige, Kette (Nachfragen), Wortmeldungen,
-- Dateianhänge und optionaler Mandantenbezug.
-- =============================================================================

-- 1) Mehrere Zuständige. EINE Aufgabe — wer abhakt, erledigt sie für alle.
CREATE TABLE IF NOT EXISTS "client_reminder_assignee" (
  "reminder_id" UUID NOT NULL,
  "staff_id"    UUID NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_reminder_assignee_pk" PRIMARY KEY ("reminder_id", "staff_id"),
  CONSTRAINT "client_reminder_assignee_reminder_fk" FOREIGN KEY ("reminder_id")
    REFERENCES "client_reminder"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "client_reminder_assignee_staff_fk" FOREIGN KEY ("staff_id")
    REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "client_reminder_assignee_staff_idx"
  ON "client_reminder_assignee" ("staff_id");

-- Bestandsdaten übernehmen, BEVOR die Einzelspalte fällt.
INSERT INTO "client_reminder_assignee" ("reminder_id", "staff_id", "created_at")
SELECT r."id", r."assignee_staff_id", r."created_at"
  FROM "client_reminder" r
 WHERE r."assignee_staff_id" IS NOT NULL
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS "client_reminder_assignee_idx";
ALTER TABLE "client_reminder" DROP COLUMN IF EXISTS "assignee_staff_id";

-- 2) Kette: Nachfrage/Folgeauftrag verweist auf die vorige Stufe.
--    SET NULL, damit das Löschen einer alten Stufe die Folgestufe nicht mitreisst.
ALTER TABLE "client_reminder"
  ADD COLUMN IF NOT EXISTS "predecessor_id" UUID;
DO $$ BEGIN
  ALTER TABLE "client_reminder"
    ADD CONSTRAINT "client_reminder_predecessor_fk" FOREIGN KEY ("predecessor_id")
    REFERENCES "client_reminder"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "client_reminder_predecessor_idx"
  ON "client_reminder" ("predecessor_id");

-- 3) Mandantenbezug optional (interne Aufgaben ohne Mandant).
--    Der Paar-Integritätstrigger behandelt NULL bereits als gültigen Zustand.
ALTER TABLE "client_reminder" ALTER COLUMN "client_id" DROP NOT NULL;

-- 4) Wortmeldungen (kurze Rückfragen ohne neue Frist).
CREATE TABLE IF NOT EXISTS "client_reminder_note" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID NOT NULL,
  "reminder_id" UUID NOT NULL,
  "staff_id"    UUID NOT NULL,
  "body"        TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_reminder_note_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_reminder_note_reminder_fk" FOREIGN KEY ("reminder_id")
    REFERENCES "client_reminder"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "client_reminder_note_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "client_reminder_note_reminder_idx"
  ON "client_reminder_note" ("reminder_id", "created_at");

-- RLS wie bei allen tenant-gebundenen Tabellen.
ALTER TABLE "client_reminder_note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_reminder_note" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "client_reminder_note_tenant" ON "client_reminder_note";
CREATE POLICY "client_reminder_note_tenant" ON "client_reminder_note"
  USING ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant_id', true)::uuid);

-- client_reminder_assignee hat kein tenant_id: die Zeilen hängen per FK an
-- client_reminder, das seinerseits RLS-geschützt ist. Ein Lesezugriff ohne
-- passenden Tenant findet den Parent nicht.

-- 5) Dateianhänge — gleiches Muster wie workflow_item_id / analysis_id.
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "reminder_id" UUID;
DO $$ BEGIN
  ALTER TABLE "document"
    ADD CONSTRAINT "document_reminder_fk" FOREIGN KEY ("reminder_id")
    REFERENCES "client_reminder"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "document_reminder_idx"
  ON "document" ("tenant_id", "reminder_id");
