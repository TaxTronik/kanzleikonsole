-- ACCESS-TENANT-RLS-001 / MANDATE-STRUCTURE-001 / CLIENT-OFFBOARDING-001.
--
-- Review-Finding P-01, verhaltensneutral. Die RESTRICTIVE-Policy
-- document_mandate_artifact_scope rief app.mandate_artifact_document_allowed()
-- für jede gelesene Dokumentzeile auf: eine nicht inlinebare SECURITY-DEFINER-
-- Funktion mit zwei Indexsuchen in mandate_artifact, auch für die weit
-- überwiegende Zahl der Dokumente ohne Mandatsartefakt. Gemessen mit 20 000
-- internen Dokumenten eines Tenants als taxtronik_app (EXPLAIN ANALYZE):
-- SELECT count(*) vorher 170-210 ms (PG 16) bzw. 260-300 ms (PG 18) bei rund
-- 20 000 bzw. 40 000 Buffer-Treffern, mit dem Flag 4-6 ms bei 381; die neuesten
-- 50 Dokumente vorher 235 bzw. 245 ms, mit dem Flag 8,5 ms.
--
-- document.has_mandate_artifact markiert Dokumente, auf die ein Mandatsartefakt
-- verweist (mandate_artifact.document_id, eindeutig). Die Policy ruft die
-- unveränderte Hilfsfunktion nur noch für markierte Dokumente auf; für alle
-- übrigen bleibt die Tenant-Bindung, die bisher die Funktion selbst prüfte.
-- Lesen und Schreiben bleiben identisch, solange jedes referenzierte Dokument
-- markiert ist. Ein markiertes Dokument ohne Artefakt ist unschädlich: Die
-- Funktion liefert dann wie bisher TRUE. Die Markierung sichern:
--  * Monotonie: Ein gesetztes Flag lässt sich nicht zurücksetzen (Trigger).
--    Es gibt daher keinen Wettlauf zwischen Setzen und Löschen.
--  * Ein AFTER-Trigger auf mandate_artifact markiert das referenzierte Dokument
--    in derselben Anweisung wie die Verknüpfung, auch für Schreiber älterer
--    Releases während des Updates. Die Funktion läuft als SECURITY DEFINER mit
--    row_security = off: Sie markiert oder bricht ab, filtert aber nie still.
--  * Bestand: Die Migration markiert alle bereits referenzierten Dokumente und
--    bricht ab, falls danach eines unmarkiert ist. Das UPDATE ändert nur das
--    Flag und durchläuft die Dokument-Guards.
-- notification_mandate_artifact_scope bleibt unverändert: resource_id ist Text,
-- dort gilt weiter die UUID-Suche aus 20261004120000.
--
-- Expand-Schritt: neue Spalte mit konstantem Default, kein Tabellen-Rewrite.
-- Ältere Releases lesen und setzen sie nicht.
BEGIN;

ALTER TABLE public."document"
  ADD COLUMN "has_mandate_artifact" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public."document"."has_mandate_artifact" IS
  'P-01: Ein Mandatsartefakt verweist auf dieses Dokument. Monoton und per Trigger gepflegt; nur markierte Dokumente durchlaufen in document_mandate_artifact_scope die Artefaktprüfung.';

CREATE FUNCTION app.mark_mandate_artifact_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  UPDATE public."document"
     SET "has_mandate_artifact" = TRUE
   WHERE "id" = NEW."document_id"
     AND NOT "has_mandate_artifact";
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.mark_mandate_artifact_document() FROM PUBLIC;

CREATE TRIGGER "mandate_artifact_mark_document"
  AFTER INSERT OR UPDATE OF "document_id" ON public."mandate_artifact"
  FOR EACH ROW
  WHEN (NEW."document_id" IS NOT NULL)
  EXECUTE FUNCTION app.mark_mandate_artifact_document();

CREATE FUNCTION app.guard_document_mandate_artifact_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'document.has_mandate_artifact kann nicht zurückgesetzt werden (P-01).'
    USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE ALL ON FUNCTION app.guard_document_mandate_artifact_flag() FROM PUBLIC;

CREATE TRIGGER "document_mandate_artifact_flag_monotonic"
  BEFORE UPDATE OF "has_mandate_artifact" ON public."document"
  FOR EACH ROW
  WHEN (OLD."has_mandate_artifact" AND NOT NEW."has_mandate_artifact")
  EXECUTE FUNCTION app.guard_document_mandate_artifact_flag();

SET LOCAL row_security = off;

UPDATE public."document" d
   SET "has_mandate_artifact" = TRUE
  FROM public."mandate_artifact" a
 WHERE a."document_id" = d."id"
   AND NOT d."has_mandate_artifact";

DO $$
DECLARE
  unmarked BIGINT;
BEGIN
  SELECT count(*)
    INTO unmarked
    FROM public."mandate_artifact" a
    JOIN public."document" d ON d."id" = a."document_id"
   WHERE NOT d."has_mandate_artifact";
  IF unmarked > 0 THEN
    RAISE EXCEPTION 'P-01: % Dokument(e) mit Mandatsartefakt sind nicht markiert.', unmarked;
  END IF;
END
$$;

ALTER POLICY "document_mandate_artifact_scope" ON public."document"
  USING (
    "tenant_id" = app.current_tenant_id()
    AND (NOT "has_mandate_artifact" OR app.mandate_artifact_document_allowed("tenant_id", "id"::TEXT))
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND (NOT "has_mandate_artifact" OR app.mandate_artifact_document_allowed("tenant_id", "id"::TEXT))
  );

COMMIT;
