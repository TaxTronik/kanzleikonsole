CREATE TRIGGER gwg_owner_person_anchor BEFORE INSERT OR UPDATE OF person_anchor_id ON public.gwg_beneficial_owner FOR EACH ROW EXECUTE FUNCTION app.assign_gwg_person_anchor();
