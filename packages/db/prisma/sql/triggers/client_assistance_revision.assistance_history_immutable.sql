CREATE TRIGGER assistance_history_immutable BEFORE DELETE OR UPDATE ON public.client_assistance_revision FOR EACH ROW EXECUTE FUNCTION app.assistance_history_append_only();
