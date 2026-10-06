CREATE TRIGGER document_payroll_scope_guard BEFORE INSERT OR UPDATE ON public.document FOR EACH ROW EXECUTE FUNCTION app.guard_document_payroll_scope();
