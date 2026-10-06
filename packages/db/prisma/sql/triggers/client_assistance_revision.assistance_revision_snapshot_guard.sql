CREATE TRIGGER assistance_revision_snapshot_guard BEFORE INSERT ON public.client_assistance_revision FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_revision_snapshot();
