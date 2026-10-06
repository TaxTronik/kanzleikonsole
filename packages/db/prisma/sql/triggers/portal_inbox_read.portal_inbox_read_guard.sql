CREATE TRIGGER portal_inbox_read_guard BEFORE INSERT OR UPDATE ON public.portal_inbox_read FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
