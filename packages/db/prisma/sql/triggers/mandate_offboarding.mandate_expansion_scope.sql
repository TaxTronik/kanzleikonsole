CREATE TRIGGER mandate_expansion_scope BEFORE INSERT OR UPDATE ON public.mandate_offboarding FOR EACH ROW EXECUTE FUNCTION app.mandate_expansion_scope();
