CREATE TRIGGER portal_inbox_attachment_guard BEFORE INSERT OR UPDATE ON public.portal_inbox_attachment FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_attachment_guard_v2();
