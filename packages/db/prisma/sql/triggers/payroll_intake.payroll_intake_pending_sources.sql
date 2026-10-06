CREATE TRIGGER payroll_intake_pending_sources BEFORE UPDATE ON public.payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_pending_sources();
