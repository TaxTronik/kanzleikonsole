CREATE TRIGGER "00_tenant_client_pair_integrity" BEFORE INSERT OR UPDATE OF tenant_id, client_id ON public.mail_outbox FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();
