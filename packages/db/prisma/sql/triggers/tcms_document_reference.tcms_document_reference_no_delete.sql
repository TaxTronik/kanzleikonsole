CREATE TRIGGER tcms_document_reference_no_delete BEFORE DELETE ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_document_reference_delete();
