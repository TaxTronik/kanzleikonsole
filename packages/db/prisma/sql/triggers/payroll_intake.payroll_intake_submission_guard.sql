CREATE TRIGGER payroll_intake_submission_guard BEFORE UPDATE ON public.payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_submission();
