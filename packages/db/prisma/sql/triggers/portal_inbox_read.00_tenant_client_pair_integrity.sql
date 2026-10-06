CREATE TRIGGER "00_tenant_client_pair_integrity" BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.portal_inbox_read FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
