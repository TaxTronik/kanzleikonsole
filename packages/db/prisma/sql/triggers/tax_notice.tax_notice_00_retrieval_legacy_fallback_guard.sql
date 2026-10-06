CREATE TRIGGER tax_notice_00_retrieval_legacy_fallback_guard BEFORE INSERT OR UPDATE ON public.tax_notice FOR EACH ROW EXECUTE FUNCTION app.tax_notice_guard_retrieval_legacy_fallback();
