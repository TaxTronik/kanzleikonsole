-- TCMS-NACHWEIS-001.
--
-- Härtung D3 aus dem Angriffsdurchlauf 3b (TCMS Stufe 3): Neue Versionen
-- eines im Tax-CMS gebundenen Dokuments sperrte bisher nur die Versions-Route
-- der Ablage. Ein anderer Pfad (oder ein direkter Insert) konnte eine neue
-- Version anlegen; die Auslieferung lehnte den Nachweis dann zwar ab
-- („Abweichung“), der Verweis zeigte aber nicht mehr auf die neueste Fassung.
--
-- Änderung: document_version_tcms_reference_guard weist für jede Rolle eine
-- neue Version ab, solange eine offene (nicht freigegebene)
-- tcms_document_reference auf das Dokument zeigt – mit derselben
-- Fehlerabbildung wie die Löschsperre (restrict_violation, Marker „als
-- Nachweis im Tax-CMS verknüpft“; die Versions-Route antwortet 409
-- locked_by_tcms_evidence). Der Trigger sperrt zuerst die Dokumentzeile (FOR
-- NO KEY UPDATE); das Anlegen einer Verknüpfung sperrt sie FOR SHARE und
-- prüft die neueste Version, so dass sich beide serialisieren.
-- Daten, RLS und Rechte bleiben unverändert.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   neu:      functions/app.guard_tcms_referenced_document_version().sql
--   neu:      triggers/document_version.document_version_tcms_reference_guard.sql
BEGIN;

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

CREATE TRIGGER document_version_tcms_reference_guard BEFORE INSERT ON public.document_version FOR EACH ROW EXECUTE FUNCTION app.guard_tcms_referenced_document_version();

COMMIT;
