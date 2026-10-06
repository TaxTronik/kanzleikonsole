CREATE TRIGGER gwg_check_no_hard_delete BEFORE DELETE ON public.gwg_check FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_check_hard_delete();
