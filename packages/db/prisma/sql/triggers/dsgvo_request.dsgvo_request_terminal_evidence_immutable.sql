CREATE TRIGGER dsgvo_request_terminal_evidence_immutable BEFORE INSERT OR UPDATE ON public.dsgvo_request FOR EACH ROW EXECUTE FUNCTION app.protect_dsgvo_terminal_evidence();
