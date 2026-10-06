CREATE TRIGGER gwg_check_natural_person_anchor AFTER INSERT ON public.gwg_check FOR EACH ROW EXECUTE FUNCTION app.ensure_gwg_natural_person_anchor();
