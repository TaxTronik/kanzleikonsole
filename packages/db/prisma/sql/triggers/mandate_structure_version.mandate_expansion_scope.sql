CREATE TRIGGER mandate_expansion_scope BEFORE INSERT OR UPDATE ON public.mandate_structure_version FOR EACH ROW EXECUTE FUNCTION app.mandate_expansion_scope();
