CREATE TRIGGER request_template_wiki_scope BEFORE INSERT OR UPDATE ON public.request_template FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
