CREATE TRIGGER workflow_resume_reconcile AFTER UPDATE OF status ON public.workflow_instance FOR EACH ROW EXECUTE FUNCTION app.reconcile_resumed_workflow();
