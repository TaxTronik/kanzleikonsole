CREATE TRIGGER invoice_protect_update BEFORE UPDATE ON public.invoice FOR EACH ROW EXECUTE FUNCTION app.invoice_protect_update();
