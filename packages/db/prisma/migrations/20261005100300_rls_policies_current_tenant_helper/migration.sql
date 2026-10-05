-- ACCESS-TENANT-RLS-001 / REMINDER-TICKET-001.
--
-- Review-Finding D-04. Sechs Policies verglichen direkt mit
-- current_setting('app.current_tenant_id', true)::uuid statt mit
-- app.current_tenant_id(). Nach einer Transaktion mit set_config(..., true)
-- steht die Einstellung auf einer Pool-Verbindung als Leerstring; der Cast
-- brach dann mit „invalid input syntax for type uuid“ ab. Ein vergessener
-- Tenant-Kontext wurde so zum 500-Fehler statt zur leeren Liste
-- (ACCESS-TENANT-RLS-001: fehlender Kontext → Zeile nicht sichtbar, Mutation
-- blockiert). app.current_tenant_id() liefert für NULL und '' ebenfalls NULL.
-- Für einen gültigen Kontext ändert sich nichts; Name, Befehl, Rollen und
-- Permissive-Modus der Policies bleiben (ALTER POLICY ändert nur die Ausdrücke).
--
-- app.current_tenant_id/actor_id/actor_type lesen nur Einstellungen
-- (current_setting, selbst PARALLEL SAFE) und casten sie; sie schreiben nichts
-- und nutzen keinen backend-lokalen Zustand außer den GUCs, die PostgreSQL an
-- parallele Worker überträgt. Als PARALLEL UNSAFE verhinderten sie jeden
-- parallelen Plan, sobald eine Policy sie aufrief. Volatilität, SECURITY
-- DEFINER und search_path bleiben unverändert (ALTER FUNCTION ... PARALLEL).
BEGIN;

ALTER POLICY "email_template_tenant_isolation" ON "email_template"
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER POLICY "wf_item_comment_tenant" ON "workflow_item_comment"
  USING (
    EXISTS (
      SELECT 1 FROM "workflow_item" wi
      JOIN "workflow_instance" wfi ON wfi.id = wi.instance_id
      WHERE wi.id = workflow_item_comment.item_id
        AND wfi.tenant_id = app.current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "workflow_item" wi
      JOIN "workflow_instance" wfi ON wfi.id = wi.instance_id
      WHERE wi.id = workflow_item_comment.item_id
        AND wfi.tenant_id = app.current_tenant_id()
    )
  );

ALTER POLICY "wf_instance_member_tenant" ON "workflow_instance_member"
  USING (
    EXISTS (
      SELECT 1 FROM "workflow_instance" wfi
      WHERE wfi.id = workflow_instance_member.instance_id
        AND wfi.tenant_id = app.current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "workflow_instance" wfi
      WHERE wfi.id = workflow_instance_member.instance_id
        AND wfi.tenant_id = app.current_tenant_id()
    )
  );

ALTER POLICY "client_reminder_tenant" ON "client_reminder"
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER POLICY "pending_binder_tenant" ON "pending_binder"
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER POLICY "client_reminder_note_tenant" ON "client_reminder_note"
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id());

ALTER FUNCTION app.current_tenant_id() PARALLEL SAFE;
ALTER FUNCTION app.current_actor_id() PARALLEL SAFE;
ALTER FUNCTION app.current_actor_type() PARALLEL SAFE;

COMMIT;
