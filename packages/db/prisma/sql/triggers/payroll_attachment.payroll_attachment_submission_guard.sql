CREATE TRIGGER payroll_attachment_submission_guard BEFORE INSERT OR UPDATE ON public.payroll_attachment FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_submission();
