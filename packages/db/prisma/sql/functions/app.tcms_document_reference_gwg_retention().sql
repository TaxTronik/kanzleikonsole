CREATE OR REPLACE FUNCTION app.tcms_document_reference_gwg_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (kk-tcms-s11): Bei der Bindung eines GwG-Belegs als
  -- Nachweis steigt seine Aufbewahrung auf die GoBD-Frist der Steuerunterlage
  -- (app.raise_tcms_gwg_evidence_retention). Heute weist der Guard der
  -- Verknüpfung GwG-Belege ab (Zugriffsbeschränkung); dieser Trigger hält die
  -- Regel für jeden Pfad, der sie künftig zulässt. Bestehende Bindungen
  -- (Altbestand) hebt die Migration 20261021150000 an.
  PERFORM app.raise_tcms_gwg_evidence_retention(NEW.document_id);
  RETURN NULL;
END;
$function$;
