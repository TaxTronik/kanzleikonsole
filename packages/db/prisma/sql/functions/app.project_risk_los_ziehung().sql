CREATE OR REPLACE FUNCTION app.project_risk_los_ziehung()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  -- TCMS-SAMPLE-PROOF-001 (Welle 15, P-11): Jede Los-Ziehung entsteht als
  -- Audit-Ereignis (Nachweis in der Hash-Chain) und in derselben Transaktion als
  -- Zeile in risk_los_ziehung, aus der die Los-Liste liest. Der Trigger statt
  -- eines zweiten Schreibaufrufs im Code bildet auch Ziehungen eines älteren
  -- Release-Standes ab (Expand/Contract, docs/operations/release.md).
  INSERT INTO public.risk_los_ziehung (
    audit_log_id, tenant_id, audit_occurred_at, commitment, rahmen_typ,
    nachweis, rahmen, zeitraum, review_aufgaben, attempt_id, job_id
  )
  SELECT NEW.id, NEW.tenant_id, NEW.occurred_at, p.commitment, p.rahmen_typ,
         p.nachweis, p.rahmen, p.zeitraum, p.review_aufgaben, p.attempt_id, p.job_id
    FROM app.risk_los_ziehung_projection(NEW.after) p;
  RETURN NULL;
END
$function$;
