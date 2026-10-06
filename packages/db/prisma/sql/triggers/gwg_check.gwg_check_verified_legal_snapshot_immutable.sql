CREATE TRIGGER gwg_check_verified_legal_snapshot_immutable BEFORE INSERT OR UPDATE ON public.gwg_check FOR EACH ROW EXECUTE FUNCTION app.protect_verified_gwg_legal_snapshot();
