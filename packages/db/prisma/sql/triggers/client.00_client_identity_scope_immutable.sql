CREATE TRIGGER "00_client_identity_scope_immutable" BEFORE UPDATE OF id, tenant_id ON public.client FOR EACH ROW EXECUTE FUNCTION app.protect_client_identity_scope();
