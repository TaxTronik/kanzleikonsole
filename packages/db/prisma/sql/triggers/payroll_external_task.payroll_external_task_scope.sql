CREATE TRIGGER payroll_external_task_scope BEFORE INSERT OR UPDATE ON public.payroll_external_task FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
