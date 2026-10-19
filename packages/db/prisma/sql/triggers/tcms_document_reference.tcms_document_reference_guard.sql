CREATE TRIGGER tcms_document_reference_guard BEFORE INSERT OR UPDATE ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_document_reference();
