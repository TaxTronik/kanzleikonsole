CREATE TRIGGER workflow_item_reconcile AFTER INSERT OR DELETE OR UPDATE OF done_at ON public.workflow_item FOR EACH ROW EXECUTE FUNCTION app.reconcile_workflow_item_change();
