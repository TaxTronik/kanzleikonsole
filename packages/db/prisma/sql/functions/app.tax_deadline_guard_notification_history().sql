CREATE OR REPLACE FUNCTION app.tax_deadline_guard_notification_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  purge_authorized BOOLEAN;
BEGIN
  -- Custom GUCs sind für jede Session frei setzbar und deshalb allein keine
  -- Autorisierung. Der Purge ist nur über dieselbe Owner-Rolle möglich, der
  -- auch die Tabelle gehört; der Runtime-User kann die Freigabe nicht imitieren.
  purge_authorized :=
    COALESCE(
      current_setting('app.tax_deadline_notification_purge', true),
      ''
    ) = 'on'
    AND current_user = pg_catalog.pg_get_userbyid(
      (
        SELECT relation.relowner
          FROM pg_catalog.pg_class relation
         WHERE relation.oid = 'public.tax_deadline'::regclass
      )
    );

  -- Ein bereits verwaister Historieneintrag ist unveränderlich. Nur derselbe
  -- explizit autorisierte Purge wie beim Request-Delete darf ihn vollständig
  -- neutralisieren; gewöhnliche Updates anderer Deadline-Felder bleiben
  -- möglich, weil der Trigger nur auf die technischen Spalten reagiert.
  IF OLD.auto_request_notification_status = 'ORPHANED' THEN
    IF purge_authorized
       AND NEW.request_id IS NULL
       AND NEW.auto_request_notification_status = 'NOT_REQUIRED'
       AND NEW.auto_request_notification_attempt_count = 0
       AND NEW.auto_request_notification_last_attempt_at IS NULL
       AND NEW.auto_request_notification_next_attempt_at IS NULL
       AND NEW.auto_request_notification_accepted_at IS NULL
       AND NEW.auto_request_notification_last_error IS NULL
       AND NEW.auto_request_notification_escalated_at IS NULL THEN
      RETURN NEW;
    END IF;

    IF ROW(
         NEW.request_id,
         NEW.auto_request_notification_status,
         NEW.auto_request_notification_attempt_count,
         NEW.auto_request_notification_last_attempt_at,
         NEW.auto_request_notification_next_attempt_at,
         NEW.auto_request_notification_accepted_at,
         NEW.auto_request_notification_last_error,
         NEW.auto_request_notification_escalated_at
       ) IS DISTINCT FROM ROW(
         OLD.request_id,
         OLD.auto_request_notification_status,
         OLD.auto_request_notification_attempt_count,
         OLD.auto_request_notification_last_attempt_at,
         OLD.auto_request_notification_next_attempt_at,
         OLD.auto_request_notification_accepted_at,
         OLD.auto_request_notification_last_error,
         OLD.auto_request_notification_escalated_at
       ) THEN
      RAISE EXCEPTION
        'Orphaned tax deadline notification history is immutable'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_orphaned_immutable_check';
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.request_id IS NOT NULL AND NEW.request_id IS NULL THEN
    -- Zwischen persistiertem Claim und eindeutigem Versandabschluss bleibt
    -- die Request-Verknüpfung gesperrt. Andernfalls könnte der externe Versand
    -- nach einem bereits committeten Unlink/Purge und damit ohne belastbare
    -- Historie erfolgen. Ein abgestürzter Claim wird vom Worker eskaliert und
    -- ist danach wieder explizit bearbeitbar.
    IF OLD.auto_request_notification_status = 'UNKNOWN'
       AND OLD.auto_request_notification_attempt_count > 0
       AND OLD.auto_request_notification_last_attempt_at IS NOT NULL
       AND OLD.auto_request_notification_escalated_at IS NULL THEN
      RAISE EXCEPTION
        'Tax deadline notification attempt is in flight; request unlink is blocked'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_unlink_in_flight_check';
    END IF;

    IF purge_authorized THEN
      IF NEW.auto_request_notification_status = 'NOT_REQUIRED'
         AND NEW.auto_request_notification_attempt_count = 0
         AND NEW.auto_request_notification_last_attempt_at IS NULL
         AND NEW.auto_request_notification_next_attempt_at IS NULL
         AND NEW.auto_request_notification_accepted_at IS NULL
         AND NEW.auto_request_notification_last_error IS NULL
         AND NEW.auto_request_notification_escalated_at IS NULL THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'Authorized tax deadline notification purge must clear all technical metadata'
        USING ERRCODE = '23514',
              CONSTRAINT = 'tax_deadline_notification_purge_shape_check';
    END IF;

    -- Reguläre Unlinks dürfen über NEW keine Historie umschreiben. Nur der
    -- Scheduler-Zeitpunkt wird entfernt, damit ORPHANED nie versendet wird.
    NEW.auto_request_notification_status := 'ORPHANED';
    NEW.auto_request_notification_attempt_count :=
      OLD.auto_request_notification_attempt_count;
    NEW.auto_request_notification_last_attempt_at :=
      OLD.auto_request_notification_last_attempt_at;
    NEW.auto_request_notification_next_attempt_at := NULL;
    NEW.auto_request_notification_accepted_at :=
      OLD.auto_request_notification_accepted_at;
    NEW.auto_request_notification_escalated_at :=
      OLD.auto_request_notification_escalated_at;
    NEW.auto_request_notification_last_error := concat_ws(
      ' ',
      NULLIF(OLD.auto_request_notification_last_error, ''),
      format(
        'Request-Verknüpfung aufgehoben; vorheriger Benachrichtigungsstatus: %s.',
        OLD.auto_request_notification_status
      )
    );
  END IF;
  RETURN NEW;
END;
$function$;
