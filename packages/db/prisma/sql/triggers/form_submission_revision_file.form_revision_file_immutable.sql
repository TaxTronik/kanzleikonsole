CREATE TRIGGER form_revision_file_immutable BEFORE INSERT OR UPDATE ON public.form_submission_revision_file FOR EACH ROW EXECUTE FUNCTION app.guard_form_submission_revision();
