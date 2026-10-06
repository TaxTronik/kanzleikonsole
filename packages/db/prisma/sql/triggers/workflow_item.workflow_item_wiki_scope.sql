CREATE TRIGGER workflow_item_wiki_scope BEFORE INSERT OR UPDATE ON public.workflow_item FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
