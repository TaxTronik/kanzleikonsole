CREATE TRIGGER payroll_export_scope BEFORE INSERT OR UPDATE ON public.payroll_export FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
