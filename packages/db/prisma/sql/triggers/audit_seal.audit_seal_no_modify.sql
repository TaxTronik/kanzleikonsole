CREATE TRIGGER audit_seal_no_modify BEFORE DELETE OR UPDATE OR TRUNCATE ON public.audit_seal FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();
