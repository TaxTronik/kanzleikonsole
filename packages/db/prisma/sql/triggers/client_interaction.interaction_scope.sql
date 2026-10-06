CREATE TRIGGER interaction_scope BEFORE INSERT OR UPDATE ON public.client_interaction FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();
