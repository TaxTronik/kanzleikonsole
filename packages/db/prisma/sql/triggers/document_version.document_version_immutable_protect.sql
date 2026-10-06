CREATE TRIGGER document_version_immutable_protect BEFORE DELETE OR UPDATE ON public.document_version FOR EACH ROW EXECUTE FUNCTION app.protect_immutable_document_version();
