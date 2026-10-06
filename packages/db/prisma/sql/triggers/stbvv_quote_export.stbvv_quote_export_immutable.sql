CREATE TRIGGER stbvv_quote_export_immutable BEFORE DELETE OR UPDATE ON public.stbvv_quote_export FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
