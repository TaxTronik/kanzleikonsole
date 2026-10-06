CREATE TRIGGER "10_portal_inbox_notification_guard" BEFORE INSERT OR UPDATE ON public.notification FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_notification_guard();
