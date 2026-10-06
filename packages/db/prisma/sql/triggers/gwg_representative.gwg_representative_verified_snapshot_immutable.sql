CREATE TRIGGER gwg_representative_verified_snapshot_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.gwg_representative FOR EACH ROW EXECUTE FUNCTION app.protect_verified_gwg_representative();
