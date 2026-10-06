CREATE TRIGGER poa_protect_integrity BEFORE INSERT OR UPDATE ON public.power_of_attorney FOR EACH ROW EXECUTE FUNCTION app.poa_protect_integrity();
