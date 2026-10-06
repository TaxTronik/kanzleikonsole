CREATE TRIGGER campaign_scope BEFORE INSERT OR UPDATE ON public.year_end_campaign FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();
