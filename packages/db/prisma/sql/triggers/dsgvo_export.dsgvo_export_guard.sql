CREATE TRIGGER dsgvo_export_guard BEFORE INSERT OR UPDATE ON public.dsgvo_export FOR EACH ROW EXECUTE FUNCTION app.guard_dsgvo_export();
