CREATE TRIGGER mandate_artifact_source_guard BEFORE INSERT OR DELETE OR UPDATE ON public.mandate_artifact_source FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact_source();
