CREATE TRIGGER staff_role_auth_state_lock BEFORE INSERT OR DELETE OR UPDATE ON public.staff_role FOR EACH ROW EXECUTE FUNCTION app.lock_staff_role_auth_state();
