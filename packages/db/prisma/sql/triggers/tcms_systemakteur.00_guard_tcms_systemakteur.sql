CREATE TRIGGER "00_guard_tcms_systemakteur" BEFORE UPDATE ON public.tcms_systemakteur FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_systemakteur();
