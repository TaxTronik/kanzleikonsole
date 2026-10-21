CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_mandate_end_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  d record;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (RT3D-K-01, kk-tcms-fix5):
  -- Mit dem Mandatsende beginnt die GwG-Frist. Für GwG-Belege mit Verweis des
  -- Tax-CMS hält app.raise_tcms_gwg_evidence_retention sie im
  -- Aufbewahrungsende fest, das für diese Belege nie sinkt. Ein später
  -- zurückgenommenes oder auf ein früheres Datum gesetztes Mandatsende
  -- verkürzt die Aufbewahrung dann nicht mehr. Ohne RLS (SECURITY DEFINER):
  -- Jeder solche Beleg des Mandanten wird angehoben, auch wenn die handelnde
  -- Person ihn nicht sieht; die Funktion hebt nur an, nie herab.
  FOR d IN
    SELECT doc.id
      FROM public.document doc
     WHERE doc.client_id = NEW.id
       AND doc.tenant_id = NEW.tenant_id
       AND doc.classification = 'GWG_EVIDENCE'
       AND EXISTS (
         SELECT 1
           FROM public.tcms_document_reference r
          WHERE r.document_id = doc.id
            AND r.tenant_id = doc.tenant_id
       )
     ORDER BY doc.id
  LOOP
    PERFORM app.raise_tcms_gwg_evidence_retention(d.id);
  END LOOP;
  RETURN NULL;
END;
$function$;
