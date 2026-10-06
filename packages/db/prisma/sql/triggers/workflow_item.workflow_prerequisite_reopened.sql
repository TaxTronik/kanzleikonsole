CREATE TRIGGER workflow_prerequisite_reopened AFTER UPDATE OF done_at ON public.workflow_item FOR EACH ROW EXECUTE FUNCTION app.workflow_prerequisite_reopened();
