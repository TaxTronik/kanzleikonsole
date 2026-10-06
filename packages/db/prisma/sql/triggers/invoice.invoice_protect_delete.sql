CREATE TRIGGER invoice_protect_delete BEFORE DELETE ON public.invoice FOR EACH ROW EXECUTE FUNCTION app.invoice_protect_delete();
