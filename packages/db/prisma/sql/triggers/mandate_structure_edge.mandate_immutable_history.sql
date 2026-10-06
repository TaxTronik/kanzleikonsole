CREATE TRIGGER mandate_immutable_history BEFORE DELETE OR UPDATE ON public.mandate_structure_edge FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_immutable_history();
