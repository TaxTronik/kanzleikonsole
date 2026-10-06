CREATE TRIGGER audit_archive_no_delete BEFORE DELETE ON public.audit_archive FOR EACH ROW EXECUTE FUNCTION app.audit_archive_block_mutation();
