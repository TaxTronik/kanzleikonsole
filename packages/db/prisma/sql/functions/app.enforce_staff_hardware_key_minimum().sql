CREATE OR REPLACE FUNCTION app.enforce_staff_hardware_key_minimum()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  target_tenant UUID;
  target_staff UUID;
  hardware_only_enabled TIMESTAMP(3);
  eligible_credentials INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'staff_user' THEN
    target_tenant := NEW."tenant_id";
    target_staff := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    target_tenant := OLD."tenant_id";
    target_staff := OLD."staff_user_id";
  ELSE
    target_tenant := NEW."tenant_id";
    target_staff := NEW."staff_user_id";
  END IF;

  SELECT su."hardware_only_enabled_at"
    INTO hardware_only_enabled
    FROM public."staff_user" su
   WHERE su."tenant_id" = target_tenant
     AND su."id" = target_staff;

  IF NOT FOUND OR hardware_only_enabled IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER
    INTO eligible_credentials
    FROM public."staff_webauthn_credential" credential
   WHERE credential."tenant_id" = target_tenant
     AND credential."staff_user_id" = target_staff
     AND credential."revoked_at" IS NULL
     AND credential."device_type" = 'singleDevice'
     AND credential."backed_up" = FALSE
     AND credential."attestation_verified_at" IS NOT NULL
     AND pg_catalog.cardinality(credential."transports") > 0
     AND credential."transports" <@ ARRAY['ble', 'nfc', 'smart-card', 'usb']::TEXT[];

  IF eligible_credentials < 2 THEN
    RAISE EXCEPTION
      'Hardware-only-Zugang erfordert mindestens zwei aktive, geraetegebundene Sicherheitsschluessel.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$function$;
