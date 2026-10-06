CREATE TRIGGER staff_role_recovery_floor BEFORE DELETE OR UPDATE OF role, staff_user_id ON public.staff_role FOR EACH ROW EXECUTE FUNCTION app.enforce_staff_recovery_role_floor();
