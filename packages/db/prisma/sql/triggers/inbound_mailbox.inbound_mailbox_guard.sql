CREATE TRIGGER inbound_mailbox_guard BEFORE INSERT OR UPDATE ON public.inbound_mailbox FOR EACH ROW EXECUTE FUNCTION app.guard_inbound_mailbox();
