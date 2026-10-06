CREATE TRIGGER portal_inbox_upload_batch_guard BEFORE INSERT OR UPDATE ON public.portal_inbox_upload_batch FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_guard();
