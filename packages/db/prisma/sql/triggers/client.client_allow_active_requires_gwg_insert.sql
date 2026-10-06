CREATE TRIGGER client_allow_active_requires_gwg_insert BEFORE INSERT ON public.client FOR EACH ROW WHEN ((new.allow_active = true)) EXECUTE FUNCTION app.enforce_client_allow_active_requires_gwg();
