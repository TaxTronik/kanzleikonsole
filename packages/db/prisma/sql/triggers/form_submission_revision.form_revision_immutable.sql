CREATE TRIGGER form_revision_immutable BEFORE INSERT OR UPDATE ON public.form_submission_revision FOR EACH ROW EXECUTE FUNCTION app.guard_form_submission_revision();
