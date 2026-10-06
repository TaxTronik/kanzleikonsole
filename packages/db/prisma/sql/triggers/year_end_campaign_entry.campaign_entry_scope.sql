CREATE TRIGGER campaign_entry_scope BEFORE INSERT OR UPDATE ON public.year_end_campaign_entry FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();
