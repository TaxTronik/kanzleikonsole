CREATE TRIGGER risk_los_ziehung_projection AFTER INSERT ON public.audit_log FOR EACH ROW WHEN ((new.action = 'risk.los.gezogen'::text)) EXECUTE FUNCTION app.project_risk_los_ziehung();
