CREATE TRIGGER assistance_case_guard BEFORE INSERT OR UPDATE ON public.client_assistance_case FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_case();
