CREATE TRIGGER gwg_person_link_scope BEFORE INSERT OR UPDATE ON public.gwg_person_link FOR EACH ROW EXECUTE FUNCTION app.validate_gwg_person_link();
