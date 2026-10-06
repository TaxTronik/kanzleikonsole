CREATE TRIGGER portal_inbox_message_touch_thread AFTER INSERT ON public.portal_inbox_message FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_touch_thread();
