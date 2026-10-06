CREATE TRIGGER document_version_form_revision_identity BEFORE UPDATE ON public.document_version FOR EACH ROW EXECUTE FUNCTION app.guard_form_revision_source_identity();
