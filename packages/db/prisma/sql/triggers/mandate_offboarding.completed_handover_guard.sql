CREATE TRIGGER completed_handover_guard BEFORE UPDATE ON public.mandate_offboarding FOR EACH ROW EXECUTE FUNCTION app.guard_completed_handover();
