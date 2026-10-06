CREATE TRIGGER document_client_active_check BEFORE INSERT ON public.document FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_document();
