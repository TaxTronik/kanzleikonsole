CREATE TRIGGER risk_los_ziehung_audit_binding BEFORE INSERT ON public.risk_los_ziehung FOR EACH ROW EXECUTE FUNCTION app.guard_risk_los_ziehung();
