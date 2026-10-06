CREATE TRIGGER gwg_structure_binding_guard BEFORE INSERT OR DELETE OR UPDATE ON public.gwg_structure_binding FOR EACH ROW EXECUTE FUNCTION app.guard_gwg_structure_binding();
