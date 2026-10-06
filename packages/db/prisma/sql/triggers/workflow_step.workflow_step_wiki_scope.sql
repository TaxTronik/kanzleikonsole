CREATE TRIGGER workflow_step_wiki_scope BEFORE INSERT OR UPDATE ON public.workflow_step FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
