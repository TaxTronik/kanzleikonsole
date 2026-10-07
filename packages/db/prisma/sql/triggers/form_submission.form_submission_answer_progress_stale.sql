CREATE TRIGGER form_submission_answer_progress_stale BEFORE UPDATE OF answers ON public.form_submission FOR EACH ROW EXECUTE FUNCTION app.reset_stale_answer_progress();
