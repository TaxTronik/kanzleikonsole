CREATE TRIGGER gwg_beneficial_owner_check_scope_immutable BEFORE UPDATE OF gwg_check_id ON public.gwg_beneficial_owner FOR EACH ROW EXECUTE FUNCTION app.protect_gwg_beneficial_owner_check_scope();
