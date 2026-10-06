CREATE TRIGGER request_workflow_item_auto_close AFTER UPDATE OF closed_at, workflow_item_id ON public.request FOR EACH ROW EXECUTE FUNCTION public.trg_request_closed_complete_workflow_item();
