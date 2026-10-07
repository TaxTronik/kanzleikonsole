-- DOC-UPLOAD-JOURNAL-001 / RISK-ARCHIVE-SNAPSHOT-001 / DOC-OBJECT-LOCK-001
-- (app.settle_storage_intent aus 20261006130100_storage_upload_intent).
--
-- Review-Finding K-06 (Folgearbeit). Risiko-Archiv (Subsumtions-Snapshot) und
-- Engine-Rohergebnisse der Risikoanalyse schrieben bisher ohne Vorab-Journal in
-- den GoBD-Bucket (Object Lock COMPLIANCE): Brach der Prozess zwischen PUT und
-- DB-Commit ab oder scheiterte der Commit, blieb ein unverknuepftes, bis zum
-- Retention-Ende unloeschbares Objekt ohne jeden Journaleintrag zurueck. Beide
-- Pfade journalisieren ihre Speicherabsicht jetzt vor dem PUT und schliessen
-- sie in der Transaktion ab, die den Verweis an der Risikoanalyse setzt
-- (raw_result_bucket/raw_result_key bzw. archive_bucket/archive_key).
--
-- app.settle_storage_intent akzeptiert dafuer neben einer Dokumentversion auch
-- den Rohergebnis- oder Archivverweis einer Risikoanalyse desselben Tenants.
-- Diese Verweise tragen keine Objektversion; jeder Versuch schreibt unter einem
-- eigenen Schluessel (bedingter PUT, genau eine Version), daher genuegen Bucket
-- und Schluessel. Signatur, SECURITY DEFINER, search_path und Volatilitaet
-- bleiben unveraendert; CREATE OR REPLACE behaelt Eigentuemer und Rechte.
--
-- Aufwand beim Deploy: reine Funktionsersetzung, keine Datenaenderung.
BEGIN;

CREATE OR REPLACE FUNCTION app.settle_storage_intent(
  p_intent_id UUID,
  p_storage_bucket TEXT,
  p_storage_key TEXT,
  p_storage_version_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
AS $$
DECLARE
  v_tenant_id UUID := app.current_tenant_id();
  v_version_id TEXT := COALESCE(p_storage_version_id, '');
  v_settled INTEGER;
BEGIN
  IF v_tenant_id IS NULL
     OR app.current_actor_type() IS NULL
     OR app.current_actor_type() NOT IN ('STAFF', 'CLIENT_CONTACT', 'SYSTEM') THEN
    RAISE EXCEPTION 'STORAGE_INTENT_CONTEXT: Speicherabsicht nur im Mandantenkontext abschliessbar.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Abschluss nur mit dauerhafter Referenz derselben Transaktion bzw. desselben
  -- Tenants: Eine als REFERENCED geschlossene Absicht wird nie mehr geloescht.
  -- Referenzen sind Dokumentversionen (mit Objektversion) und die Rohergebnis-
  -- bzw. Archivverweise einer Risikoanalyse (Schluessel je Versuch eindeutig).
  IF NOT EXISTS (
    SELECT 1
      FROM public.document_version version
      JOIN public.document document ON document.id = version.document_id
     WHERE version.storage_bucket = p_storage_bucket
       AND version.storage_key = p_storage_key
       AND version.storage_version_id IS NOT DISTINCT FROM NULLIF(v_version_id, '')
       AND document.tenant_id = v_tenant_id
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.risk_analysis analysis
     WHERE analysis.tenant_id = v_tenant_id
       AND (
         (analysis.raw_result_bucket = p_storage_bucket AND analysis.raw_result_key = p_storage_key)
         OR (analysis.archive_bucket = p_storage_bucket AND analysis.archive_key = p_storage_key)
       )
  ) THEN
    RAISE EXCEPTION 'STORAGE_INTENT_UNREFERENCED: Speicherabsicht ohne Dokumentversion oder Risikoanalyse.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  UPDATE public.storage_orphan journal
     SET storage_version_id = v_version_id,
         resolution = 'REFERENCED',
         cleaned_at = now(),
         cleanup_error = NULL,
         updated_at = now()
   WHERE journal.id = p_intent_id
     AND journal.tenant_id = v_tenant_id
     AND journal.intent
     AND journal.cleaned_at IS NULL
     AND journal.cleanup_claimed_at IS NULL
     AND journal.storage_bucket = p_storage_bucket
     AND journal.storage_key = p_storage_key
     AND journal.storage_version_id IN ('', v_version_id);
  GET DIAGNOSTICS v_settled = ROW_COUNT;
  IF v_settled <> 1 THEN
    RAISE EXCEPTION 'STORAGE_INTENT_NOT_OPEN: Speicherabsicht ist nicht mehr offen.'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;

COMMIT;
