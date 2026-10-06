CREATE TRIGGER payroll_attachment_scope BEFORE INSERT OR UPDATE ON public.payroll_attachment FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
