CREATE TRIGGER document_gwg_invite_scope_and_claim BEFORE INSERT OR DELETE OR UPDATE ON public.document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_document_invite_and_claim();
