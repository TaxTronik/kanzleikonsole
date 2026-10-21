CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_classification_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (RT3D-K-01, kk-tcms-fix5): Wird ein früherer Nachweis
  -- nach der Freigabe seiner Bindung zum GwG-Beleg (Umklassifizierung der
  -- Ablage mit Re-Store in den GwG-Bucket), gilt er ab dann als steuerliche
  -- Unterlage wie ein gebundener GwG-Beleg: Sein Aufbewahrungsende steigt wie
  -- bei einer Bindung (app.raise_tcms_gwg_evidence_retention); bisher hielt
  -- nur der Claim die Steuerfrist (kk-tcms-s11, offener Punkt 2).
  PERFORM app.raise_tcms_gwg_evidence_retention(NEW.id);
  RETURN NULL;
END;
$function$;
