CREATE TRIGGER form_submission_frozen_schema BEFORE INSERT OR UPDATE ON public.form_submission FOR EACH ROW EXECUTE FUNCTION app.freeze_submission_schema();
