CREATE TRIGGER client_reminder_allocate_ticket_number BEFORE INSERT ON public.client_reminder FOR EACH ROW EXECUTE FUNCTION app.allocate_reminder_ticket_number();
