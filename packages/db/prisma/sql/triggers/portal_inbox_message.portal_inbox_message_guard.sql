CREATE TRIGGER portal_inbox_message_guard BEFORE INSERT OR UPDATE ON public.portal_inbox_message FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
