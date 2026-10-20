CREATE OR REPLACE FUNCTION app.guard_tcms_portal_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (kk-tcms-s10nach): Meldevorgang einer Ereignismeldung
  -- aus dem Portal mit Idempotenzschlüssel (TCMS s10). Eine Zeile entsteht vor
  -- dem Ablegen der Anlagen (noch nicht gesendet); unmittelbar vor dem ersten
  -- Senden kommen Sendezeitpunkt und der verschlüsselte Inhalt dazu (CHECK:
  -- beides oder keines, nur im Format der Secret-Box). Kontakt, Mandant,
  -- Schlüssel und Anlage sind unveränderlich, der Sendezeitpunkt wird genau
  -- einmal gesetzt. Gelöscht wird die Zeile nach der Klärung (angenommen,
  -- eindeutig abgelehnt) bzw. nach Ablauf des Wiederholungsfensters.
  IF TG_OP = 'INSERT' THEN
    IF NEW.sent_at IS NOT NULL OR NEW.payload_enc IS NOT NULL
       OR NEW.attempts <> 0 OR NEW.last_attempt_at IS NOT NULL THEN
      RAISE EXCEPTION 'tcms_portal_report: ein neuer Meldevorgang ist noch nicht gesendet'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM 1
       FROM public.client_contact c
      WHERE c.id = NEW.contact_id
        AND c.tenant_id = NEW.tenant_id
        AND c.client_id = NEW.client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tcms_portal_report: Kontakt gehört nicht zu diesem Mandanten'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.contact_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.contact_id, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'tcms_portal_report: Bezug und Schlüssel sind unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'tcms_portal_report: der Sendezeitpunkt wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;
