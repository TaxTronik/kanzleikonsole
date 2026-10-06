CREATE TRIGGER request_wiki_scope BEFORE INSERT OR UPDATE ON public.request FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
