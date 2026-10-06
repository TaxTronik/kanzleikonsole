CREATE TRIGGER audit_log_no_modify BEFORE DELETE OR UPDATE OR TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();
