CREATE TRIGGER request_client_active_check BEFORE INSERT ON public.request FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_request();
