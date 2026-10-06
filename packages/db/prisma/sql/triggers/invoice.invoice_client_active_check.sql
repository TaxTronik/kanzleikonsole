CREATE TRIGGER invoice_client_active_check BEFORE INSERT ON public.invoice FOR EACH ROW EXECUTE FUNCTION app.enforce_client_active_for_invoice();
