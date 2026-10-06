CREATE TRIGGER structure_edge_version_seal BEFORE INSERT ON public.mandate_structure_edge FOR EACH ROW EXECUTE FUNCTION app.guard_structure_version_children();
