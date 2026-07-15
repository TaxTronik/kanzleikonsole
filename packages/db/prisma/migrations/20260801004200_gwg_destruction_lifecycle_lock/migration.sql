-- Serialisiert die endgültige Check-Vernichtung mit allen übrigen
-- statusentscheidenden GwG-Pfaden desselben Tenant-/Mandanten-Paars.
--
-- Die bestehende, bereits produktiv ausgerollte Implementierung bleibt als
-- nicht aufrufbarer SECURITY-DEFINER-Kern erhalten. Der öffentliche Einstieg
-- ermittelt nur den Scope, nimmt vor jeder Zeilensperre denselben Advisory-
-- xact-Lock wie die Anwendung und delegiert dann an den unveränderten Kern.

ALTER FUNCTION app.destroy_gwg_check(UUID)
  RENAME TO destroy_gwg_check_locked_impl;

-- Trigger autorisieren die kontrollierte Vernichtung über den Owner von
-- app.destroy_gwg_check(uuid). Wrapper und Implementierung müssen deshalb
-- denselben Owner haben, auch wenn diese Migration als Superuser eingespielt
-- wird und die Bestandsfunktion ursprünglich einer anderen Rolle gehörte.
ALTER FUNCTION app.destroy_gwg_check_locked_impl(UUID)
  OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM taxtronik_app;

CREATE FUNCTION app.destroy_gwg_check(p_check_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  check_tenant UUID;
  check_client UUID;
  lifecycle_lock_key TEXT;
BEGIN
  -- Reine Scope-Auflösung ohne Zeilensperre. Erst der Advisory-Lock, danach
  -- nimmt die Implementierung ihre Sperren in der Reihenfolge
  -- Client -> Check -> Invites -> Ausweise -> wirtschaftlich Berechtigte.
  SELECT gc."tenant_id", gc."client_id"
    INTO check_tenant, check_client
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Prüfung nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Vor dem potentiell wartenden Advisory-Lock fremde Tenant-Scopes abweisen.
  -- Die Implementierung wiederholt sämtliche Actor-/Scope-Prüfungen nach dem
  -- Lock und bleibt damit die autoritative fachliche Prüfung.
  IF app.current_tenant_id() IS NULL OR check_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Prüfung gehört nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  lifecycle_lock_key :=
    'gwg-check-lifecycle:' || check_tenant::TEXT || ':' || check_client::TEXT;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lifecycle_lock_key, 0)
  );

  RETURN app.destroy_gwg_check_locked_impl(p_check_id);
END;
$$;

COMMENT ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) IS
  'Interner GwG-Vernichtungskern; ausschließlich über app.destroy_gwg_check(uuid) aufrufen.';
COMMENT ON FUNCTION app.destroy_gwg_check(UUID) IS
  'Vernichtet einen fälligen GwG-Check unter dem mandantenbezogenen Lifecycle-Advisory-Lock.';

REVOKE ALL ON FUNCTION app.destroy_gwg_check(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(UUID) TO taxtronik_app;
