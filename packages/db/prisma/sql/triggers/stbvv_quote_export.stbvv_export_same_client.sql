CREATE TRIGGER stbvv_export_same_client BEFORE INSERT ON public.stbvv_quote_export FOR EACH ROW EXECUTE FUNCTION app.stbvv_export_same_client();
