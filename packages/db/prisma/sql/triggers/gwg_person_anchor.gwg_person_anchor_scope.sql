CREATE TRIGGER gwg_person_anchor_scope BEFORE INSERT OR UPDATE ON public.gwg_person_anchor FOR EACH ROW EXECUTE FUNCTION app.validate_gwg_person_anchor();
