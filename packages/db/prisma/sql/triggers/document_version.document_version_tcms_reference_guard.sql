CREATE TRIGGER document_version_tcms_reference_guard BEFORE INSERT ON public.document_version FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_referenced_document_version();
