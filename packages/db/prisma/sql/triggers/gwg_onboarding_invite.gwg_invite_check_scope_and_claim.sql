CREATE TRIGGER gwg_invite_check_scope_and_claim BEFORE INSERT OR UPDATE ON public.gwg_onboarding_invite FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_invite_check_scope_and_claim();
