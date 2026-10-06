-- DOC-UPLOAD-JOURNAL-001 / DOC-OBJECT-LOCK-001 / DOC-RETENTION-CLASS-001
-- (storage_orphan aus 20260823120000_workflow_consistency_backstops).
--
-- Review-Finding K-06. Bisher schrieben die direkten Upload-Pfade (Staff- und
-- Portal-Upload, neue Version, Formular-, Erklaerungs- und Rechnungs-PDF,
-- Wissensanhang, Umklassifizierung, Rechnungsarchiv, Rechercheablage) zuerst
-- in den Object Store und journalisierten erst nach einem gescheiterten
-- DB-Commit. Brach der Prozess zwischen PUT und DB-Commit ab, blieb ein nicht
-- auffindbares, unter Object Lock nicht loeschbares Objekt zurueck.
--
-- Jetzt schreibt jeder dieser Pfade VOR dem PUT eine Speicherabsicht
-- (intent = TRUE) mit festem Bucket, Schluessel, SHA-256, Groesse, Schutz und
-- Retention. Die fachliche Commit-Transaktion schliesst sie atomar ueber
-- app.settle_storage_intent als REFERENCED ab. Bleibt sie offen (Abbruch,
-- gescheiterter Commit), findet der Cleanup-Worker sie nach der
-- Sicherheitsfrist (bei Object Lock nach dem Retention-Ende): referenziert ->
-- REFERENCED, Objekt vorhanden und unreferenziert -> versionsgenau DELETED,
-- nie geschrieben -> ABSENT. ABSENT ist ausschliesslich fuer Vorab-Absichten
-- ohne gebundene Objektversion zulaessig; ein nachtraeglich journalisierter
-- Orphan verlangt weiterhin den Nachweis einer konkreten Version.
--
-- app.settle_storage_intent laeuft in der Fachtransaktion (auch fuer
-- Portal- und GwG-Kontexte, die das Journal per RLS nicht sehen). Das UPDATE
-- haelt die Zeilensperre bis zum Commit: Ein paralleler Worker-Claim wartet
-- und findet danach eine abgeschlossene Absicht. Hat der Worker die Absicht
-- bereits beansprucht oder abgeschlossen, scheitert der Fachcommit, statt ein
-- moeglicherweise schon geloeschtes Objekt zu referenzieren.
--
-- Aufwand beim Deploy: Spalte mit konstantem Default ist eine reine
-- Katalogaenderung; der CHECK prueft den Bestand einmal (alle intent = FALSE,
-- keine ABSENT-Zeilen). Der Teilindex deckt nur offene Eintraege ab; das
-- Journal waechst kuenftig um eine abgeschlossene Zeile je Upload.
BEGIN;

ALTER TABLE public.storage_orphan
  ADD COLUMN intent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT storage_orphan_absent_intent_check
    CHECK (resolution IS DISTINCT FROM 'ABSENT' OR (intent AND storage_version_id = ''));

COMMENT ON COLUMN public.storage_orphan.intent IS
  'TRUE: vor dem Object-Write journalisierte Speicherabsicht (DOC-UPLOAD-JOURNAL-001). '
  'Das Objekt kann fehlen; der Cleanup-Worker schliesst sie dann als ABSENT ab.';

-- Auswahl und Rueckstand des Cleanup-Workers betreffen nur offene Eintraege.
CREATE INDEX storage_orphan_open_idx
  ON public.storage_orphan (cleanup_attempts, created_at, id)
  WHERE cleaned_at IS NULL;

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
  IF NOT EXISTS (
    SELECT 1
      FROM public.document_version version
      JOIN public.document document ON document.id = version.document_id
     WHERE version.storage_bucket = p_storage_bucket
       AND version.storage_key = p_storage_key
       AND version.storage_version_id IS NOT DISTINCT FROM NULLIF(v_version_id, '')
       AND document.tenant_id = v_tenant_id
  ) THEN
    RAISE EXCEPTION 'STORAGE_INTENT_UNREFERENCED: Speicherabsicht ohne Dokumentversion.'
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

REVOKE ALL ON FUNCTION app.settle_storage_intent(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.settle_storage_intent(UUID, TEXT, TEXT, TEXT) TO taxtronik_app;

COMMIT;
