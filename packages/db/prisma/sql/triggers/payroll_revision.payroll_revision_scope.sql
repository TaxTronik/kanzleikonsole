CREATE TRIGGER payroll_revision_scope BEFORE INSERT OR UPDATE ON public.payroll_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
