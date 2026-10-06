CREATE TRIGGER payroll_intake_scope BEFORE INSERT OR UPDATE ON public.payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
