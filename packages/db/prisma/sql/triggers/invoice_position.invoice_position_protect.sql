CREATE TRIGGER invoice_position_protect BEFORE INSERT OR DELETE OR UPDATE ON public.invoice_position FOR EACH ROW EXECUTE FUNCTION app.invoice_position_protect();
