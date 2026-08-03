-- RLS für client_reminder_assignee — vom verify:rls-Gate angemahnt.
--
-- Die Tabelle kam in 20260803180000 bewusst ohne tenant_id ("hängt per FK am
-- RLS-geschützten Parent"). Das deckt aber nur Zugriffe ÜBER den Parent:
-- eine direkte Query auf die Zuweisungstabelle (z. B. der staffId-Einstieg
-- „was liegt bei mir") wäre auf DB-Ebene nicht tenant-beschränkt gewesen.
-- RLS ist die letzte harte Grenze (§203, ADR 0002) — App-Filter reichen nicht.
--
-- Gleiches Muster wie workflow_item (ebenfalls ohne eigene tenant_id):
-- EXISTS-Policy über den Parent, der die tenant_id trägt.
ALTER TABLE "client_reminder_assignee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_reminder_assignee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "client_reminder_assignee_isolation" ON "client_reminder_assignee";
CREATE POLICY "client_reminder_assignee_isolation" ON "client_reminder_assignee"
  USING (EXISTS (
    SELECT 1 FROM "client_reminder" r
    WHERE r."id" = "client_reminder_assignee"."reminder_id"
      AND r."tenant_id" = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "client_reminder" r
    WHERE r."id" = "client_reminder_assignee"."reminder_id"
      AND r."tenant_id" = app.current_tenant_id()
  ));
