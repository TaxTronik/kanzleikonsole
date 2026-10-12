CREATE OR REPLACE FUNCTION app.guard_risk_los_ziehung()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- TCMS-SAMPLE-PROOF-001 (Welle 15): Eine Zeile bildet genau ein vorhandenes
  -- Audit-Ereignis risk.los.gezogen desselben Tenants ab, Feld für Feld. Auch die
  -- App-Rolle kann so keine Ziehung ohne Nachweis in der Hash-Chain anlegen.
  IF NOT EXISTS (
    SELECT 1
      FROM public.audit_log a
     CROSS JOIN LATERAL app.risk_los_ziehung_projection(a.after) p
     WHERE a.id = NEW.audit_log_id
       AND a.tenant_id = NEW.tenant_id
       AND a.action = 'risk.los.gezogen'
       AND a.occurred_at = NEW.audit_occurred_at
       AND (p.commitment, p.rahmen_typ, p.nachweis, p.rahmen, p.zeitraum,
            p.review_aufgaben, p.attempt_id, p.job_id)
           IS NOT DISTINCT FROM
           (NEW.commitment, NEW.rahmen_typ, NEW.nachweis, NEW.rahmen, NEW.zeitraum,
            NEW.review_aufgaben, NEW.attempt_id, NEW.job_id)
  ) THEN
    RAISE EXCEPTION 'risk_los_ziehung % bildet kein Audit-Ereignis risk.los.gezogen ab',
      NEW.audit_log_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;
