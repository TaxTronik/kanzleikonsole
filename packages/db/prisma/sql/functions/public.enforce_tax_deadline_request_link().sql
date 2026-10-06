CREATE OR REPLACE FUNCTION public.enforce_tax_deadline_request_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  current_deadline public."tax_deadline"%ROWTYPE;
  current_request public."request"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'tax_deadline' THEN
    -- Deferred Trigger müssen den finalen Zeilenzustand erneut lesen: dieselbe
    -- Transaktion kann nach dem auslösenden UPDATE noch die Gegenseite ändern
    -- oder die Zeile löschen (z. B. FK-SET-NULL bei Neu-Materialisierung).
    SELECT * INTO current_deadline
      FROM public."tax_deadline" deadline
     WHERE deadline.id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF current_deadline.request_id IS NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public."request" request_row
         WHERE request_row.tax_deadline_id = current_deadline.id
           AND NOT (
             current_deadline.auto_request_notification_status = 'ORPHANED'
             AND request_row.status IN ('RESPONDED', 'CLOSED', 'CANCELLED')
             AND request_row.tenant_id = current_deadline.tenant_id
             AND request_row.client_id = current_deadline.client_id
           )
      ) THEN
        RAISE EXCEPTION
          'tax_deadline/request pointer mismatch for deadline %',
          current_deadline.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public."request" request_row
         WHERE request_row.id = current_deadline.request_id
           AND request_row.tax_deadline_id = current_deadline.id
           AND request_row.tenant_id = current_deadline.tenant_id
           AND request_row.client_id = current_deadline.client_id
      ) THEN
        RAISE EXCEPTION
          'tax_deadline/request pointer mismatch for deadline %',
          current_deadline.id;
      END IF;
    END IF;
  ELSE
    SELECT * INTO current_request
      FROM public."request" request_row
     WHERE request_row.id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF current_request.tax_deadline_id IS NULL THEN
      IF EXISTS (
        SELECT 1
          FROM public."tax_deadline" deadline
         WHERE deadline.request_id = current_request.id
      ) THEN
        RAISE EXCEPTION
          'request/tax_deadline pointer mismatch for request %',
          current_request.id;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1
          FROM public."tax_deadline" deadline
         WHERE deadline.id = current_request.tax_deadline_id
           AND deadline.tenant_id = current_request.tenant_id
           AND deadline.client_id = current_request.client_id
           AND (
             deadline.request_id = current_request.id
             OR (
               deadline.request_id IS NULL
               AND deadline.auto_request_notification_status = 'ORPHANED'
               AND current_request.status IN ('RESPONDED', 'CLOSED', 'CANCELLED')
             )
           )
      ) THEN
        RAISE EXCEPTION
          'request/tax_deadline pointer mismatch for request %',
          current_request.id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
