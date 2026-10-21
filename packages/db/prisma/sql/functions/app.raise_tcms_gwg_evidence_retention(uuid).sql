CREATE OR REPLACE FUNCTION app.raise_tcms_gwg_evidence_retention(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  raised integer;
  ziel timestamp;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung (document.retention_until) steigt auf die
  -- GoBD-Frist der Steuerunterlage (app.tcms_gwg_evidence_tax_retention_until)
  -- und sinkt nie. Die GwG-Vernichtung prüft retention_until in Aktion und
  -- Claim; sie ist damit erst fällig, wenn beide Fristen abgelaufen sind, auch
  -- nach der Freigabe der Verknüpfung.
  -- RT3D-K-01 (kk-tcms-fix5): Ist das Mandat beendet, steigt das Ende
  -- zusätzlich auf das Ende der GwG-Frist: 1. Januar des sechsten Jahres nach
  -- dem Jahr des Mandatsendes, wie im Claim (dort in der Zeitzone der Sitzung),
  -- mindestens nach dem deutschen Kalenderjahr. Da retention_until dieser
  -- Belege nie sinkt (app.guard_tcms_referenced_document_retention), verkürzt
  -- ein später zurückgenommenes oder früher eingetragenes Mandatsende die
  -- Aufbewahrung nicht mehr; der Trigger client_tcms_gwg_evidence_retention
  -- hebt bei jedem neuen Mandatsende an.
  -- Nicht angehoben werden: ein fehlendes Aufbewahrungsende (NULL hält die
  -- Vernichtung fail closed gesperrt; ein Datum würde sie später erlauben),
  -- vorgemerkte und vernichtete Belege (deren Felder sind eingefroren,
  -- app.guard_gwg_document_invite_and_claim) – für sie gilt dieselbe Frist über
  -- den Claim (app.assert_gwg_document_destruction_due).
  -- Läuft mit den Rechten des Aufrufers (RLS des Tenants); heben kann sie nur,
  -- verkürzen nie.
  SELECT GREATEST(
           app.tcms_gwg_evidence_tax_retention_until(doc.created_at),
           make_date(
             GREATEST(
               EXTRACT(YEAR FROM c.mandate_ended_at::timestamp),
               EXTRACT(YEAR FROM c.mandate_ended_at AT TIME ZONE 'Europe/Berlin')
             )::integer + 6,
             1,
             1
           )::timestamp
         )
    INTO ziel
    FROM public.document doc
    LEFT JOIN public.client c
      ON c.id = doc.client_id AND c.tenant_id = doc.tenant_id
   WHERE doc.id = p_document_id;
  UPDATE public.document d
     SET retention_until = ziel
   WHERE d.id = p_document_id
     AND d.classification = 'GWG_EVIDENCE'
     AND d.gwg_destruction_requested_at IS NULL
     AND d.gwg_destroyed_at IS NULL
     AND d.retention_until IS NOT NULL
     AND d.retention_until < ziel
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
