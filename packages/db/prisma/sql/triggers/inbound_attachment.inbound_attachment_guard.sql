CREATE TRIGGER inbound_attachment_guard BEFORE INSERT OR UPDATE ON public.inbound_attachment FOR EACH ROW EXECUTE FUNCTION app.guard_inbound_attachment();
