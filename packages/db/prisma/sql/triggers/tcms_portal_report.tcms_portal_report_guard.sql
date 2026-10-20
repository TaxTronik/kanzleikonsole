CREATE TRIGGER tcms_portal_report_guard BEFORE INSERT OR UPDATE ON public.tcms_portal_report FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_portal_report();
