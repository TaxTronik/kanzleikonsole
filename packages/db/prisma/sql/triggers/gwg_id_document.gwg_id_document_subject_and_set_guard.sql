CREATE TRIGGER gwg_id_document_subject_and_set_guard BEFORE INSERT OR UPDATE ON public.gwg_id_document FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_id_document_subject_and_set();
