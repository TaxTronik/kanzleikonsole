CREATE TRIGGER stbvv_quote_immutable BEFORE DELETE OR UPDATE ON public.stbvv_quote FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
