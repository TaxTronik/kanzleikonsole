CREATE TRIGGER mandate_source_reservation BEFORE INSERT ON public.mandate_artifact_source FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_source_reservation();
