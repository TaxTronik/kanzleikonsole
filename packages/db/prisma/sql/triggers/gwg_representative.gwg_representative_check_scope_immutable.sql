CREATE TRIGGER gwg_representative_check_scope_immutable BEFORE UPDATE OF gwg_check_id ON public.gwg_representative FOR EACH ROW EXECUTE FUNCTION app.protect_gwg_representative_check_scope();
