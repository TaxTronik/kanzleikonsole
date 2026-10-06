CREATE TRIGGER tax_notice_progress_evidence_trigger BEFORE UPDATE OF status ON public.tax_notice FOR EACH ROW EXECUTE FUNCTION app.tax_notice_require_progress_evidence();
