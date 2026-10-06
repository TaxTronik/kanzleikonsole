CREATE TRIGGER screening_run_immutable BEFORE DELETE OR UPDATE ON public.screening_run FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
