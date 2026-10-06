CREATE TRIGGER workflow_completion_feedback BEFORE UPDATE OF status ON public.workflow_instance FOR EACH ROW EXECUTE FUNCTION app.workflow_completion_feedback();
