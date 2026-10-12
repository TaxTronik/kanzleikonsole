CREATE OR REPLACE FUNCTION app.mail_outbox_purge_terminal(p_cutoff timestamp with time zone, p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_deleted INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR app.current_actor_type() IS DISTINCT FROM 'SYSTEM' THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_PURGE_CONTEXT: Löschung nur im Systemkontext einer Kanzlei.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Sicherung gegen einen falsch berechneten Stichtag: Er muss mindestens ein
  -- Jahr zurückliegen; ein Tag Toleranz für Schalttag und Uhrabweichung.
  IF p_cutoff IS NULL OR p_cutoff > now() - interval '1 year' + interval '1 day' THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_PURGE_CUTOFF: Der Stichtag muss mindestens ein Jahr zurückliegen.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'MAIL_OUTBOX_PURGE_LIMIT: Stapelgröße 1 bis 1000.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Nur Endstatus. Maßgeblich ist der letzte Statuswechsel: bei FAILED und
  -- UNKNOWN die Eskalation (das spätere Entfernen des Neuversandinhalts ändert
  -- updated_at, nicht den Status), sonst updated_at. Wartende und laufende
  -- Aufträge (QUEUED, RETRY_PENDING, SENDING) bleiben immer erhalten.
  WITH due AS (
    SELECT o."id"
      FROM public."mail_outbox" AS o
     WHERE o."tenant_id" = v_tenant_id
       AND (
         (o."status" IN ('PROVIDER_ACCEPTED', 'PARTIAL_FAILURE', 'NO_RECIPIENT', 'SKIPPED')
          AND o."updated_at" < p_cutoff)
         OR (o."status" IN ('FAILED', 'UNKNOWN')
             AND COALESCE(o."escalated_at", o."updated_at") < p_cutoff)
       )
     ORDER BY o."updated_at", o."id"
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public."mail_outbox" AS target
   USING due
   WHERE target."id" = due."id";
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
