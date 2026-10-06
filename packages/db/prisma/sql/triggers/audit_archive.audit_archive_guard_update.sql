CREATE TRIGGER audit_archive_guard_update BEFORE UPDATE ON public.audit_archive FOR EACH ROW EXECUTE FUNCTION app.audit_archive_guard_update();
