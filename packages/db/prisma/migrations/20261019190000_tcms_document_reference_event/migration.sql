-- TCMS-NACHWEIS-001.
--
-- TCMS s7 (Integration): Anlagen einer Ereignismeldung aus dem Portal sind
-- im Tax-CMS Verweise auf Dokumente der kanzleikonsole (Dokument-ID,
-- SHA-256) wie die Nachweise einer Durchführung. tcms_document_reference
-- bindet sie deshalb ebenso: tcms_subject unterscheidet den Bezug
-- (EXECUTION: Nachweis einer Durchführung; EVENT: Anlage einer
-- Ereignismeldung), tcms_event_id hält das Ereignis, sobald das Tax-CMS die
-- Meldung angenommen hat. Gebunden wird in der Commit-Transaktion der Ablage,
-- also bevor die Meldung den Dienst erreicht; bis dahin ist die Ereignis-ID
-- leer.
--
-- Integrität:
--   - tcms_document_reference_subject_check: genau ein Bezug – EXECUTION mit
--     Durchführung und ohne Ereignis, EVENT ohne Durchführung und ohne
--     Nachweis-ID; DISCARDED (Meldung verworfen) nur für EVENT, REMOVED
--     (Nachweis entfernt) nur für EXECUTION.
--   - Ereignis-ID im Format der Objekt-IDs des Dienstes.
--   - Der Guard hält Bezug (tcms_subject) und Durchführung unveränderlich und
--     setzt die Ereignis-ID höchstens einmal (nicht nach einer Freigabe).
--   - Löschsperre (document_tcms_reference_delete_guard), RLS und
--     Rechte gelten unverändert für beide Bezüge.
-- Bestehende Zeilen sind Nachweise (EXECUTION); der Standardwert dient nur
-- dem Nachtragen und entfällt danach, damit jeder Schreiber den Bezug nennt.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.guard_tcms_document_reference().sql
BEGIN;

ALTER TABLE public."tcms_document_reference"
  ADD COLUMN "tcms_subject" TEXT NOT NULL DEFAULT 'EXECUTION',
  ADD COLUMN "tcms_event_id" TEXT,
  ALTER COLUMN "tcms_execution_id" DROP NOT NULL;
ALTER TABLE public."tcms_document_reference" ALTER COLUMN "tcms_subject" DROP DEFAULT;

ALTER TABLE public."tcms_document_reference"
  DROP CONSTRAINT "tcms_document_reference_execution_id_check",
  ADD CONSTRAINT "tcms_document_reference_execution_id_check"
    CHECK ("tcms_execution_id" IS NULL OR "tcms_execution_id" ~ '^[a-z0-9]{1,64}$'),
  ADD CONSTRAINT "tcms_document_reference_event_id_check"
    CHECK ("tcms_event_id" IS NULL OR "tcms_event_id" ~ '^[a-z0-9]{1,64}$'),
  DROP CONSTRAINT "tcms_document_reference_release_check",
  ADD CONSTRAINT "tcms_document_reference_release_check" CHECK (
    ("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL)
    OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL
        AND "release_reason" IN ('REMOVED', 'NOT_ATTACHED', 'DISCARDED'))
  ),
  ADD CONSTRAINT "tcms_document_reference_subject_check" CHECK (
    ("tcms_subject" = 'EXECUTION' AND "tcms_execution_id" IS NOT NULL
      AND "tcms_event_id" IS NULL
      AND "release_reason" IS DISTINCT FROM 'DISCARDED')
    OR ("tcms_subject" = 'EVENT' AND "tcms_execution_id" IS NULL
      AND "tcms_evidence_id" IS NULL
      AND "release_reason" IS DISTINCT FROM 'REMOVED')
  );

-- Anlagen eines Ereignisses (Freigabe nach dem Verwerfen); trägt den Mandanten-FK.
CREATE INDEX "tcms_document_reference_client_id_tcms_event_id_idx"
  ON public."tcms_document_reference"("client_id", "tcms_event_id");

CREATE OR REPLACE FUNCTION app.guard_tcms_document_reference()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  neueste RECORD;
BEGIN
  -- TCMS-NACHWEIS-001 (TCMS Stufe 3): Verweis eines Tax-CMS-Nachweises auf ein
  -- Dokument der kanzleikonsole. Angelegt wird er nur für die neueste, sauber
  -- finalisierte Version eines nicht gelöschten Dokuments genau dieses
  -- Mandanten mit genau diesem SHA-256 und ohne GwG-, Personal- oder
  -- Lohnbezug. Danach sind Bezug und Inhalt unveränderlich; die Nachweis-ID
  -- des Tax-CMS wird höchstens einmal gesetzt, die Freigabe ist endgültig.
  -- TCMS s7 (Integration): Anlagen einer Ereignismeldung aus dem Portal
  -- (tcms_subject = 'EVENT') binden das Dokument ebenso. Die Ereignis-ID
  -- vergibt das Tax-CMS erst mit der Meldung; sie wird höchstens einmal
  -- gesetzt, der Bezug (Durchführung oder Ereignis) nie geändert.
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.released_by IS NOT NULL
       OR NEW.release_reason IS NOT NULL THEN
      RAISE EXCEPTION 'tcms_document_reference: ein neuer Verweis ist nicht freigegeben'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Die Dokumentzeile wird geteilt gesperrt: Ein paralleles Soft-Delete
    -- (FOR UPDATE der Löschaktion) wartet bzw. lässt diesen Insert scheitern.
    PERFORM 1
       FROM public.document d
      WHERE d.id = NEW.document_id
        AND d.tenant_id = NEW.tenant_id
        AND d.client_id = NEW.client_id
        AND d.deleted_at IS NULL
        AND d.gwg_destroyed_at IS NULL
        AND d.gwg_onboarding_invite_id IS NULL
        AND d.form_submission_id IS NULL
        AND d.requires_payroll_access = FALSE
        AND d.classification NOT IN ('GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE')
        FOR SHARE OF d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tcms_document_reference: Dokument dieses Mandanten nicht verfügbar'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT v.id, v.sha256, v.scan_status, v.scan_completed_at
      INTO neueste
      FROM public.document_version v
     WHERE v.document_id = NEW.document_id
     ORDER BY v.version_no DESC
     LIMIT 1;
    IF NOT FOUND
       OR neueste.id IS DISTINCT FROM NEW.document_version_id
       OR neueste.sha256 IS DISTINCT FROM NEW.sha256
       OR neueste.scan_status IS DISTINCT FROM 'CLEAN'
       OR neueste.scan_completed_at IS NULL THEN
      RAISE EXCEPTION 'tcms_document_reference: nur die neueste, saubere Version mit diesem SHA-256'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.client_id, NEW.document_id, NEW.document_version_id,
      NEW.sha256, NEW.tcms_subject, NEW.tcms_execution_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.client_id, OLD.document_id, OLD.document_version_id,
      OLD.sha256, OLD.tcms_subject, OLD.tcms_execution_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'tcms_document_reference: Bezug und Inhalt sind unveränderlich'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tcms_evidence_id IS DISTINCT FROM OLD.tcms_evidence_id
     AND (OLD.tcms_evidence_id IS NOT NULL OR OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tcms_document_reference: die Nachweis-ID wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tcms_event_id IS DISTINCT FROM OLD.tcms_event_id
     AND (OLD.tcms_event_id IS NOT NULL OR OLD.released_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tcms_document_reference: die Ereignis-ID wird nur einmal gesetzt'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL
     AND (NEW.released_at, NEW.released_by, NEW.release_reason)
         IS DISTINCT FROM (OLD.released_at, OLD.released_by, OLD.release_reason) THEN
    RAISE EXCEPTION 'tcms_document_reference: eine Freigabe ist endgültig'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

COMMIT;
