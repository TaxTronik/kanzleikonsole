CREATE TRIGGER payroll_employee_invite_scope BEFORE INSERT OR UPDATE ON public.payroll_employee_invite FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
