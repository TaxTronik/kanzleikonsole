CREATE OR REPLACE FUNCTION app.allocate_reminder_ticket_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- 0 ist ausschließlich INSERT-Sentinel, niemals ein gespeicherter Wert.
  IF NEW.ticket_number IS NOT NULL AND NEW.ticket_number <> 0 THEN
    RAISE EXCEPTION 'Ticketnummern werden ausschließlich automatisch vergeben.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.client_reminder_counter AS counter (tenant_id, last_number)
  VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id) DO UPDATE SET last_number = counter.last_number + 1
  RETURNING last_number INTO NEW.ticket_number;
  RETURN NEW;
END;
$function$;
