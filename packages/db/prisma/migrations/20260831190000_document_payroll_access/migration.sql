-- ACCESS-STAFF-PERMISSION-001 / DOC-PORTAL-SHARING-001.
-- Additive: no existing archive classification or historical sharing is rewritten.
ALTER TABLE document ADD COLUMN requires_payroll_access BOOLEAN NOT NULL DEFAULT FALSE;
CREATE POLICY document_payroll_restriction ON document AS RESTRICTIVE FOR ALL
USING (NOT requires_payroll_access OR app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.expansion_staff_permission(tenant_id,app.current_actor_id(),'PAYROLL_MANAGE')))
WITH CHECK (NOT requires_payroll_access OR app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.expansion_staff_permission(tenant_id,app.current_actor_id(),'PAYROLL_MANAGE')));
CREATE FUNCTION app.guard_document_payroll_scope() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.requires_payroll_access AND NOT NEW.requires_payroll_access THEN RAISE EXCEPTION 'payroll scope cannot be downgraded'; END IF;
 IF NEW.requires_payroll_access AND NEW.shared_with_client_at IS NOT NULL THEN RAISE EXCEPTION 'payroll archive cannot be shared with the general portal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_payroll_scope_guard BEFORE INSERT OR UPDATE ON document FOR EACH ROW EXECUTE FUNCTION app.guard_document_payroll_scope();
CREATE FUNCTION app.document_payroll_scope_allowed(tid UUID,did TEXT) RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT tid=app.current_tenant_id() AND (NOT EXISTS(SELECT 1 FROM public.document d WHERE d.id::text=did AND d.tenant_id=tid AND d.requires_payroll_access)
 OR app.current_actor_type()='SYSTEM'
 OR (app.current_actor_type()='STAFF' AND app.expansion_staff_permission(tid,app.current_actor_id(),'PAYROLL_MANAGE')))
$$;
REVOKE ALL ON FUNCTION app.document_payroll_scope_allowed(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.document_payroll_scope_allowed(UUID,TEXT) TO taxtronik_app;
CREATE POLICY notification_document_payroll_scope ON notification AS RESTRICTIVE FOR ALL
USING(resource_type IS DISTINCT FROM 'document' OR app.document_payroll_scope_allowed(tenant_id,resource_id))
WITH CHECK(resource_type IS DISTINCT FROM 'document' OR app.document_payroll_scope_allowed(tenant_id,resource_id));
