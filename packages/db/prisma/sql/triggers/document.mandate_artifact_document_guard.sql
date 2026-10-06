CREATE TRIGGER mandate_artifact_document_guard BEFORE UPDATE ON public.document FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact_document();
