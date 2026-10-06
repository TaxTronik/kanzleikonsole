CREATE TRIGGER mandate_release_guard BEFORE INSERT OR DELETE OR UPDATE ON public.mandate_offboarding_document FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_release();
