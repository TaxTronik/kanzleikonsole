CREATE TRIGGER gwg_id_document_scope_and_claim BEFORE INSERT OR DELETE OR UPDATE ON public.gwg_id_document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_scope_and_claim();
