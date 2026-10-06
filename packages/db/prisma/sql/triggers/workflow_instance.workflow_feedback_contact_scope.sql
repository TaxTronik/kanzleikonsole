CREATE TRIGGER workflow_feedback_contact_scope BEFORE INSERT OR UPDATE ON public.workflow_instance FOR EACH ROW EXECUTE FUNCTION app.check_workflow_feedback_contact();
