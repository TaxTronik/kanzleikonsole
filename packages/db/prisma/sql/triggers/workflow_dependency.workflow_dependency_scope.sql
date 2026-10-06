CREATE TRIGGER workflow_dependency_scope BEFORE INSERT OR UPDATE ON public.workflow_dependency FOR EACH ROW EXECUTE FUNCTION app.workflow_dependency_scope();
