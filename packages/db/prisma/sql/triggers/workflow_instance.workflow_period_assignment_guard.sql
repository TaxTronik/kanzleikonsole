CREATE TRIGGER workflow_period_assignment_guard BEFORE UPDATE OF assessment_year ON public.workflow_instance FOR EACH ROW EXECUTE FUNCTION app.workflow_period_assignment_guard();
