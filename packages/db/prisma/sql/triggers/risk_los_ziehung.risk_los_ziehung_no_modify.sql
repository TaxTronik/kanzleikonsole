CREATE TRIGGER risk_los_ziehung_no_modify BEFORE DELETE OR UPDATE OR TRUNCATE ON public.risk_los_ziehung FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_modification();
