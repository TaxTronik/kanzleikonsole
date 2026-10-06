CREATE TRIGGER assistance_output_guard BEFORE INSERT OR UPDATE ON public.client_assistance_output FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_output();
