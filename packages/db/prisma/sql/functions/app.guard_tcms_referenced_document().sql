CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (TCMS Stufe 3): Ein Dokument, auf das ein offener
  -- Nachweis-Verweis des Tax-CMS zeigt, wird auf keinem Pfad still gelöscht
  -- (Soft-Delete). Die Löschaktion der Dokumentablage prüft vorher selbst und
  -- nennt den Grund; dieser Trigger ist die Rückfallebene für jeden Pfad.
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
       AND r.tenant_id = OLD.tenant_id
       AND r.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Löschen gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;
