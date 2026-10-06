CREATE TRIGGER audit_anchor_no_modify BEFORE DELETE OR UPDATE OR TRUNCATE ON public.audit_anchor FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();
