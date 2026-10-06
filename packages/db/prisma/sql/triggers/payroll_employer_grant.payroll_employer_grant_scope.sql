CREATE TRIGGER payroll_employer_grant_scope BEFORE INSERT OR UPDATE ON public.payroll_employer_grant FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
