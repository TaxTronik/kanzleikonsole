CREATE TRIGGER staff_webauthn_credential_state_lock BEFORE INSERT OR DELETE OR UPDATE ON public.staff_webauthn_credential FOR EACH ROW EXECUTE FUNCTION app.lock_staff_hardware_auth_state();
