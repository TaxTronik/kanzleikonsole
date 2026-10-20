CREATE OR REPLACE FUNCTION app.guard_tcms_referenced_document_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (Härtung D3 aus dem Angriffsdurchlauf 3b): Ein Verweis
  -- des Tax-CMS bindet genau die verwiesene Fassung. Solange eine Verknüpfung
  -- offen ist, bekommt das Dokument auf keinem Pfad eine neue Version; die
  -- Versions-Route prüft vorher selbst und nennt den Grund, dieser Trigger ist
  -- die Rückfallebene. Die Dokumentzeile wird zuerst gesperrt (FOR NO KEY
  -- UPDATE): Das Anlegen einer Verknüpfung sperrt sie FOR SHARE und prüft die
  -- neueste Version – wer zuerst sperrt, gewinnt, nie beides. Die Prüfung ist
  -- ein eigenes Statement nach der Sperre und sieht eine inzwischen
  -- committete Verknüpfung.
  PERFORM 1
     FROM public.document d
    WHERE d.id = NEW.document_id
      FOR NO KEY UPDATE OF d;
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = NEW.document_id
       AND r.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document_version: als Nachweis im Tax-CMS verknüpft, neue Version gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;
