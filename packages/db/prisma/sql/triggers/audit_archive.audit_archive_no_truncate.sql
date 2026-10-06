CREATE TRIGGER audit_archive_no_truncate BEFORE TRUNCATE ON public.audit_archive FOR EACH STATEMENT EXECUTE FUNCTION app.audit_archive_block_truncate();
