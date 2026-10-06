CREATE TRIGGER purge_gwg_structure_bindings AFTER UPDATE OF destroyed_at ON public.gwg_check FOR EACH ROW EXECUTE FUNCTION app.purge_gwg_structure_bindings();
