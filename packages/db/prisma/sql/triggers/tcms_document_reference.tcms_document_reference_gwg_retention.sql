CREATE TRIGGER tcms_document_reference_gwg_retention AFTER INSERT ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.tcms_document_reference_gwg_retention();
