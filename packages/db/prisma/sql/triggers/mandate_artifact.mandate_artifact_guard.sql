CREATE TRIGGER mandate_artifact_guard BEFORE INSERT OR UPDATE ON public.mandate_artifact FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact();
