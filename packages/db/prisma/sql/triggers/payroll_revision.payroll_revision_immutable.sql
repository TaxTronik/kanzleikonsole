CREATE TRIGGER payroll_revision_immutable BEFORE UPDATE ON public.payroll_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
