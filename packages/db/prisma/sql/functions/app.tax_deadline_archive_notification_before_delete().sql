CREATE OR REPLACE FUNCTION app.tax_deadline_archive_notification_before_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  historical_request_id UUID := OLD.request_id;
  historical_request_status public."request_status";
BEGIN
  IF OLD.auto_request_notification_status = 'UNKNOWN'
     AND OLD.auto_request_notification_attempt_count > 0
     AND OLD.auto_request_notification_last_attempt_at IS NOT NULL
     AND OLD.auto_request_notification_escalated_at IS NULL THEN
    RAISE EXCEPTION
      'Tax deadline notification attempt is in flight; deadline delete is blocked'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tax_deadline_notification_delete_in_flight_check';
  END IF;

  -- Beim expliziten Tenant-Purge gibt es keinen fortbestehenden fachlichen
  -- Bezug, an den ein Hilfsnachweis gebunden werden könnte. PostgreSQL hat die
  -- Parent-Zeile vor den FK-Cascades bereits entfernt. Ein UNKNOWN-Claim bleibt
  -- durch die vorstehende Prüfung trotzdem auch bei diesem Delete gesperrt.
  IF NOT EXISTS (
    SELECT 1
      FROM public."tenant" tenant_row
     WHERE tenant_row.id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;

  IF OLD.auto_request_notification_status = 'NOT_REQUIRED' THEN
    RETURN OLD;
  END IF;

  IF historical_request_id IS NULL THEN
    SELECT request_row.id, request_row.status
      INTO historical_request_id, historical_request_status
      FROM public."request" request_row
     WHERE request_row.tax_deadline_id = OLD.id;
  ELSE
    SELECT request_row.status
      INTO historical_request_status
      FROM public."request" request_row
     WHERE request_row.id = historical_request_id
       AND request_row.tax_deadline_id = OLD.id
       AND request_row.tenant_id = OLD.tenant_id
       AND request_row.client_id = OLD.client_id;
  END IF;

  IF historical_request_id IS NULL
     OR COALESCE(historical_request_status::TEXT, '')
       NOT IN ('RESPONDED', 'CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'Tax deadline notification history requires a terminal request before deadline delete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'tax_deadline_notification_delete_request_terminal_check';
  END IF;

  INSERT INTO public."tax_deadline_notification_history" (
    "tenant_id",
    "original_deadline_id",
    "request_id",
    "notification_status",
    "notification_attempt_count",
    "notification_last_attempt_at",
    "notification_next_attempt_at",
    "notification_accepted_at",
    "notification_error_recorded",
    "notification_last_error_sha256",
    "notification_escalated_at",
    "archive_reason"
  ) VALUES (
    OLD.tenant_id,
    OLD.id,
    historical_request_id,
    OLD.auto_request_notification_status,
    OLD.auto_request_notification_attempt_count,
    OLD.auto_request_notification_last_attempt_at,
    OLD.auto_request_notification_next_attempt_at,
    OLD.auto_request_notification_accepted_at,
    OLD.auto_request_notification_last_error IS NOT NULL,
    CASE
      WHEN OLD.auto_request_notification_last_error IS NULL THEN NULL
      ELSE digest(OLD.auto_request_notification_last_error, 'sha256')
    END,
    OLD.auto_request_notification_escalated_at,
    CASE
      WHEN OLD.auto_request_notification_status = 'ORPHANED'
        THEN 'ORPHANED_DEADLINE_REMOVED'
      ELSE 'TERMINAL_REQUEST_DEADLINE_REMOVED'
    END
  );

  RETURN OLD;
END;
$function$;
