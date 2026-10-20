CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (RT3B-K-01): Ein Dokument, auf das ein offener Verweis
  -- des Tax-CMS zeigt, bleibt in dem Rahmen, in dem es verknüpft werden durfte
  -- (app.guard_tcms_document_reference): keine GwG-, Personal- oder private
  -- Mitarbeiterunterlage, kein Lohnbezug, kein Onboarding- oder
  -- Formularbezug. Sonst liefe ein Nachweis etwa als GwG-Beleg in die
  -- GwG-Pflichtvernichtung. Die Umklassifizierung der Ablage prüft vorher
  -- selbst und nennt den Grund; dieser Trigger ist die Rückfallebene für
  -- jeden Pfad (WHEN des Triggers: nur Wechsel in einen solchen Rahmen).
  -- kk-tcms-s10nach: Ebenso bleibt ein gebundenes Dokument bei seinem
  -- Mandanten und Tenant. Ein Wechsel von client_id (auf einen anderen
  -- Mandanten oder NULL) oder tenant_id ließe den Verweis des Tax-CMS auf ein
  -- Dokument eines anderen Mandanten zeigen; die Auslieferung prüft den
  -- Mandanten, der Verweis wäre aber still gebrochen. Kein Anwendungspfad
  -- ändert diese Spalten; gesperrt ist es für jede Rolle.
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
       AND r.tenant_id = OLD.tenant_id
       AND r.released_at IS NULL
  ) THEN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Mandantenwechsel gesperrt'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;
