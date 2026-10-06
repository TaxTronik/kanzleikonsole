CREATE OR REPLACE FUNCTION app.guard_reminder_ticket_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.ticket_number IS DISTINCT FROM OLD.ticket_number THEN
    RAISE EXCEPTION 'Die Identität eines Tickets ist unveränderlich.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.origin_risk_marking_id IS DISTINCT FROM OLD.origin_risk_marking_id
    AND (NEW.origin_risk_marking_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.risk_marking WHERE id = OLD.origin_risk_marking_id
    )) THEN
    RAISE EXCEPTION 'Die Rechercheherkunft eines Tickets ist unveränderlich.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
