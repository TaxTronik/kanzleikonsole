CREATE TRIGGER portal_inbox_thread_guard BEFORE INSERT OR UPDATE ON public.portal_inbox_thread FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_thread_guard_v2();
