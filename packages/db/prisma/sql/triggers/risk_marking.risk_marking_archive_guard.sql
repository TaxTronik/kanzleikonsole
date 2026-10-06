CREATE TRIGGER risk_marking_archive_guard BEFORE INSERT OR DELETE OR UPDATE ON public.risk_marking FOR EACH ROW EXECUTE FUNCTION app.guard_risk_marking_archive();
