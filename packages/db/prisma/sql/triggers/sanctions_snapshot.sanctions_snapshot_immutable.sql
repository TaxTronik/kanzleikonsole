CREATE TRIGGER sanctions_snapshot_immutable BEFORE DELETE OR UPDATE ON public.sanctions_snapshot FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
