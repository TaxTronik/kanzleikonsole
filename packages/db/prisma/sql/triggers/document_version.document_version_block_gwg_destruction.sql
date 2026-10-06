CREATE TRIGGER document_version_block_gwg_destruction BEFORE INSERT OR DELETE OR UPDATE ON public.document_version FOR EACH ROW EXECUTE FUNCTION app.block_version_during_gwg_destruction();
