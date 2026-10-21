CREATE OR REPLACE FUNCTION app.raise_tcms_gwg_evidence_retention(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  raised integer;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung (document.retention_until) steigt auf die
  -- GoBD-Frist der Steuerunterlage (app.tcms_gwg_evidence_tax_retention_until)
  -- und sinkt nie. Die GwG-Vernichtung prüft retention_until in Aktion und
  -- Claim; sie ist damit erst fällig, wenn beide Fristen abgelaufen sind, auch
  -- nach der Freigabe der Verknüpfung.
  -- Nicht angehoben werden: ein fehlendes Aufbewahrungsende (NULL hält die
  -- Vernichtung fail closed gesperrt; ein Datum würde sie später erlauben),
  -- vorgemerkte und vernichtete Belege (deren Felder sind eingefroren,
  -- app.guard_gwg_document_invite_and_claim) – für sie gilt dieselbe Frist über
  -- den Claim (app.assert_gwg_document_destruction_due).
  -- Läuft mit den Rechten des Aufrufers (RLS des Tenants); heben kann sie nur,
  -- verkürzen nie.
  UPDATE public.document d
     SET retention_until = app.tcms_gwg_evidence_tax_retention_until(d.created_at)
   WHERE d.id = p_document_id
     AND d.classification = 'GWG_EVIDENCE'
     AND d.gwg_destruction_requested_at IS NULL
     AND d.gwg_destroyed_at IS NULL
     AND d.retention_until IS NOT NULL
     AND d.retention_until < app.tcms_gwg_evidence_tax_retention_until(d.created_at)
     AND EXISTS (
       SELECT 1
         FROM public.tcms_document_reference r
        WHERE r.document_id = d.id
          AND r.tenant_id = d.tenant_id
     );
  GET DIAGNOSTICS raised = ROW_COUNT;
  RETURN raised;
END;
$function$;
