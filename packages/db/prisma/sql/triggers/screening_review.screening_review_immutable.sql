CREATE TRIGGER screening_review_immutable BEFORE DELETE OR UPDATE ON public.screening_review FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
