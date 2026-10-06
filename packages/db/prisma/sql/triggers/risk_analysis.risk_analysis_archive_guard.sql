CREATE TRIGGER risk_analysis_archive_guard BEFORE INSERT OR DELETE OR UPDATE ON public.risk_analysis FOR EACH ROW EXECUTE FUNCTION app.guard_risk_analysis_archive();
