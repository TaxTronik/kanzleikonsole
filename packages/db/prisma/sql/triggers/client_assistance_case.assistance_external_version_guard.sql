CREATE TRIGGER assistance_external_version_guard BEFORE INSERT OR UPDATE ON public.client_assistance_case FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_external_version();
