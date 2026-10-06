CREATE TRIGGER structure_node_version_seal BEFORE INSERT ON public.mandate_structure_node FOR EACH ROW EXECUTE FUNCTION app.guard_structure_version_children();
