CREATE TRIGGER mandate_expansion_scope BEFORE INSERT OR UPDATE ON public.vdb_record FOR EACH ROW EXECUTE FUNCTION app.mandate_expansion_scope();
