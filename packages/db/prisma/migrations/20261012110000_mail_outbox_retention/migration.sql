-- Fachkatalog: MAIL-OUTBOX-001, DSGVO-OPERATIONAL-RETENTION-001
-- (mail_outbox aus 20261006120000_mail_outbox)
--
-- Welle 15, Entscheidung A8 („1 Jahr wie die Versandhistorie“): Versandaufträge
-- der Mail-Outbox wurden nie gelöscht. Nach dem Endstatus bleiben nur
-- Metadaten (Anlass, Status, Zeitpunkte, Zähler, Vorgangs- und Mandantenbezug,
-- Begründung eines Verwerfens). Der tägliche Worker mail-outbox-retention
-- löscht Aufträge im Endstatus (PROVIDER_ACCEPTED, PARTIAL_FAILURE,
-- NO_RECIPIENT, FAILED, UNKNOWN, SKIPPED), deren letzter Statuswechsel länger
-- als ein Jahr zurückliegt; QUEUED, RETRY_PENDING und SENDING nie. Die Frist
-- entspricht der pseudonymen Steuertermin-Versandhistorie im Worker
-- dsgvo-retention (ein Kalenderjahr, strikt älter als der Stichtag).
--
-- Die App-Rolle erhält weiterhin kein DELETE auf mail_outbox. Die Löschung
-- kapselt app.mail_outbox_purge_terminal: nur im SYSTEM-Kontext einer Kanzlei
-- (der Worker ruft sie je Tenant über withSystemContext auf), nur Endstatus,
-- nur mit einem Stichtag, der mindestens ein Jahr (ein Tag Toleranz)
-- zurückliegt, und höchstens 1.000 Aufträge je Aufruf. Bei FAILED und UNKNOWN
-- zählt die Eskalation als Statuswechsel, weil das Entfernen des
-- Neuversandinhalts nach 30 Tagen updated_at, aber nicht den Status ändert.
-- Gesperrte Zeilen (laufender Neuversand) werden übersprungen und im nächsten
-- Lauf erneut geprüft. EXECUTE für App- und Owner-Rolle (Parität,
-- 20261006160000_owner_role_least_privilege).
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.mail_outbox_purge_terminal(timestamptz,int4).sql
BEGIN;

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

REVOKE ALL ON FUNCTION app.mail_outbox_purge_terminal(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mail_outbox_purge_terminal(TIMESTAMPTZ, INTEGER)
  TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.mail_outbox_purge_terminal(TIMESTAMPTZ, INTEGER)
  TO taxtronik_owner;

COMMIT;
