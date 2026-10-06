CREATE TRIGGER payroll_employee_data_scope BEFORE INSERT OR UPDATE ON public.payroll_employee_data FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
