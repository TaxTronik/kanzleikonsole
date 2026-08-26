-- Forward-only repair for two exactly attested pre-release migration states.
--
-- Fachkatalog:
--   ACCESS-CLIENT-MODE-001
--   ACCESS-NOTIFICATION-RECIPIENT-001
--   ACCESS-TENANT-RLS-001
--   INV-ARCHIVE-EINVOICE-001
--   TAX-CONTROL-STATUS-001
--   TAX-DEADLINE-AUTOREQUEST-001
--   TAX-NOTICE-APPEAL-001
--
-- Existing migrations remain immutable. This migration restores their
-- documented security/evidence behavior and only then converges the Prisma
-- ledger from the exact known legacy checksums to the repository checksums.

BEGIN;

CREATE TEMP TABLE known_late_security_drift (
  migration_name TEXT PRIMARY KEY,
  legacy_checksum TEXT NOT NULL,
  canonical_checksum TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO known_late_security_drift (
  migration_name,
  legacy_checksum,
  canonical_checksum
)
VALUES
  (
    '20260823201000_tax_professional_control_model',
    'b828cca902a2336b2419e4817fe9a90e661726b747e62b58327ff524e8a5b676',
    '7c401ee74bc4de95f24cf84349634122cb03e6d76384f2387c39baa1e51e94aa'
  ),
  (
    '20260823202000_notification_client_scope',
    '2c245e87e70139c3d49c4e798a15ba367e87ebceb7548918b33fad7a1dd78379',
    '48a645cea2c55377835a3da0d925937e8edfba9faa748010e0a7ed87ac15e80d'
  );

DO $late_security_drift_attestation$
DECLARE
  known RECORD;
  active_rows INTEGER;
  actual_checksum TEXT;
BEGIN
  FOR known IN SELECT * FROM known_late_security_drift ORDER BY migration_name LOOP
    SELECT COUNT(*), MIN(checksum)
      INTO active_rows, actual_checksum
      FROM public._prisma_migrations
     WHERE migration_name = known.migration_name
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL;

    IF active_rows <> 1
       OR actual_checksum NOT IN (known.legacy_checksum, known.canonical_checksum) THEN
      RAISE EXCEPTION
        'Unknown or missing late security migration ledger state for %: rows %, checksum %',
        known.migration_name,
        active_rows,
        COALESCE(actual_checksum, '<missing>')
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
END;
$late_security_drift_attestation$;

-- Trigger functions must remain callable by their triggers but not directly by
-- the application role. FROM PUBLIC alone is insufficient when an explicit
-- role ACL exists.
DO $xrechnung_function_owner$
DECLARE
  invoice_owner NAME;
  document_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO invoice_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = 'public.invoice'::regclass;

  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO document_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = 'public.document'::regclass;

  IF invoice_owner IS NULL OR document_owner IS NULL THEN
    RAISE EXCEPTION 'Could not resolve XRechnung table owners'
      USING ERRCODE = 'data_exception';
  END IF;

  IF invoice_owner IS DISTINCT FROM document_owner THEN
    RAISE EXCEPTION
      'XRechnung invoice/document table owners differ: invoice %, document %',
      invoice_owner,
      document_owner
      USING ERRCODE = 'data_exception';
  END IF;

  EXECUTE format(
    'ALTER FUNCTION app.enforce_invoice_xrechnung_document_scope() OWNER TO %I',
    invoice_owner
  );
  EXECUTE format(
    'ALTER FUNCTION app.enforce_xrechnung_document_invoice_scope() OWNER TO %I',
    invoice_owner
  );
END;
$xrechnung_function_owner$;

REVOKE ALL ON FUNCTION app.enforce_invoice_xrechnung_document_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_invoice_xrechnung_document_scope() FROM taxtronik_app;
REVOKE ALL ON FUNCTION app.enforce_xrechnung_document_invoice_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_xrechnung_document_invoice_scope() FROM taxtronik_app;

-- Restore the current evidence gates without inventing facts for historical
-- partial-relief rows.
-- Hold the write-conflicting lock through the attestation and constraint repair
-- so no incomplete evidence pair can commit in between them.
LOCK TABLE public."tax_notice" IN SHARE ROW EXCLUSIVE MODE;

DO $partial_relief_pair_attestation$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."tax_notice"
     WHERE ("partial_relief_received_at" IS NULL)
           <> ("partial_relief_received_by" IS NULL)
  ) THEN
    RAISE EXCEPTION
      'Historical partial relief evidence contains an incomplete date/staff pair'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$partial_relief_pair_attestation$;

ALTER TABLE public."tax_notice"
  DROP CONSTRAINT IF EXISTS "tax_notice_partial_relief_evidence_check";

ALTER TABLE public."tax_notice"
  ADD CONSTRAINT "tax_notice_partial_relief_evidence_check"
  CHECK (
    (("partial_relief_received_at" IS NULL) = ("partial_relief_received_by" IS NULL))
  ) NOT VALID;

CREATE OR REPLACE FUNCTION app.tax_notice_require_progress_evidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'BESTANDSKRAEFTIG'::public.tax_notice_status THEN
    IF OLD.status NOT IN (
      'GEPRUEFT'::public.tax_notice_status,
      'ABGEHOLFEN'::public.tax_notice_status,
      'ZURUECKGEWIESEN'::public.tax_notice_status,
      'KLAGE'::public.tax_notice_status
    ) THEN
      RAISE EXCEPTION 'bestandskraft is not permitted from the current procedure status';
    END IF;

    IF OLD.status = 'GEPRUEFT'::public.tax_notice_status AND (
      NEW.deadline_calculation_status <> 'CALCULATED'
      OR NEW.manual_review_required
      OR NEW.appeal_deadline IS NULL
      OR NEW.appeal_filed_at IS NOT NULL
      OR NEW.legal_final_at IS NULL
      OR NEW.legal_final_at::date <= NEW.appeal_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft without an appeal requires the elapsed, fully calculated appeal deadline';
    END IF;

    IF OLD.status = 'ZURUECKGEWIESEN'::public.tax_notice_status AND (
      OLD.klage_deadline IS NULL
      OR NEW.legal_final_at IS NULL
      OR NEW.legal_final_at::date <= OLD.klage_deadline
    ) THEN
      RAISE EXCEPTION
        'bestandskraft after an appeal decision requires the elapsed court deadline';
    END IF;
  END IF;

  IF OLD.status IN (
    'EINSPRUCH'::public.tax_notice_status,
    'ABGEHOLFEN'::public.tax_notice_status,
    'TEILABHILFE'::public.tax_notice_status,
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (NEW.appeal_filed_at IS NULL OR NEW.appeal_filed_by IS NULL) THEN
    RAISE EXCEPTION 'appeal filing evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'ABGEHOLFEN'::public.tax_notice_status
     AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'TEILABHILFE'::public.tax_notice_status
     AND (
       NEW.partial_relief_received_at IS NULL
       OR NEW.partial_relief_received_by IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence must be completed before status progress';
  END IF;

  IF NEW.partial_relief_received_at IS NOT NULL AND (
    (
      NEW.appeal_resolved_at IS NOT NULL
      AND NEW.appeal_resolved_at::date < NEW.partial_relief_received_at
    )
    OR (
      NEW.appeal_decision_received_at IS NOT NULL
      AND NEW.appeal_decision_received_at < NEW.partial_relief_received_at
    )
    OR (
      NEW.klage_filed_at IS NOT NULL
      AND NEW.klage_filed_at::date < NEW.partial_relief_received_at
    )
    OR (
      NEW.legal_final_at IS NOT NULL
      AND NEW.legal_final_at::date < NEW.partial_relief_received_at
    )
  ) THEN
    RAISE EXCEPTION 'procedure progress must not predate the partial relief receipt';
  END IF;

  IF OLD.status IN (
    'TEILEINSPRUCHSENTSCHEIDUNG'::public.tax_notice_status,
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND (
    NEW.appeal_decision_received_at IS NULL
    OR NEW.appeal_decision_legal_remedy_instruction_valid IS NULL
    OR NEW.klage_deadline IS NULL
  ) THEN
    RAISE EXCEPTION 'appeal decision evidence must be completed before status progress';
  END IF;

  IF OLD.status IN (
    'ZURUECKGEWIESEN'::public.tax_notice_status,
    'KLAGE'::public.tax_notice_status
  ) AND NEW.appeal_resolved_at IS NULL THEN
    RAISE EXCEPTION 'final appeal resolution evidence must be completed before status progress';
  END IF;

  IF OLD.status = 'KLAGE'::public.tax_notice_status
     AND (NEW.klage_filed_at IS NULL OR NEW.klage_filed_by IS NULL) THEN
    RAISE EXCEPTION 'court filing evidence must be completed before status progress';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.tax_notice_require_progress_evidence()
  SET search_path = pg_catalog, public, pg_temp;

-- Historische TEILABHILFE-Zeilen ohne eindeutig bezeichneten Bekanntgabetag
-- werden nicht allein wegen dieses fehlenden Ereignispaars blockiert; die
-- übrigen Nachweis-Constraints gelten unverändert. Bei Neuanlage/Eintritt in
-- TEILABHILFE ist das vollständige Paar Pflicht. Ein einmal dokumentierter
-- Nachweis bleibt auch in Folgestatus unveränderlich. So erfindet die Migration
-- keine Alttatsachen und lässt eine spätere Aktenbestätigung nicht verschwinden.
CREATE OR REPLACE FUNCTION app.tax_notice_guard_partial_relief_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
       AND (
         NEW."partial_relief_received_at" IS NULL
         OR NEW."partial_relief_received_by" IS NULL
       ) THEN
      RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."partial_relief_received_at" IS NOT NULL
     AND (
       NEW."partial_relief_received_at" IS DISTINCT FROM OLD."partial_relief_received_at"
       OR NEW."partial_relief_received_by" IS DISTINCT FROM OLD."partial_relief_received_by"
     ) THEN
    RAISE EXCEPTION 'partial relief receipt evidence is immutable once recorded'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'TEILABHILFE'::public."tax_notice_status"
     AND OLD."status" IS DISTINCT FROM NEW."status"
     AND (
       NEW."partial_relief_received_at" IS NULL
       OR NEW."partial_relief_received_by" IS NULL
     ) THEN
    RAISE EXCEPTION 'partial relief requires receipt date and documenting staff';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.tax_notice_guard_partial_relief_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.tax_notice_guard_partial_relief_evidence() FROM taxtronik_app;

DROP TRIGGER IF EXISTS tax_notice_partial_relief_evidence_guard
  ON public."tax_notice";

CREATE TRIGGER tax_notice_partial_relief_evidence_guard
  BEFORE INSERT OR UPDATE OF
    "status",
    "partial_relief_received_at",
    "partial_relief_received_by"
  ON public."tax_notice"
  FOR EACH ROW EXECUTE FUNCTION app.tax_notice_guard_partial_relief_evidence();

-- Only the server-side reassessment path may call this SECURITY DEFINER
-- function. A freely settable GUC is not authorization.
REVOKE ALL ON FUNCTION app.tax_notice_apply_calculated_reassessment(
  UUID,
  TIMESTAMP(3),
  DATE,
  DATE,
  TEXT,
  BOOLEAN,
  TEXT,
  BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.tax_notice_apply_calculated_reassessment(
  UUID,
  TIMESTAMP(3),
  DATE,
  DATE,
  TEXT,
  BOOLEAN,
  TEXT,
  BOOLEAN
) FROM taxtronik_app;

-- This internal delivery-history snapshot deliberately has no application
-- table privilege. RLS remains as defense in depth for any future explicit
-- administrative path.
ALTER TABLE public."tax_deadline_notification_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."tax_deadline_notification_history" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tax_deadline_notification_history_select"
  ON public."tax_deadline_notification_history";

CREATE POLICY "tax_deadline_notification_history_select"
  ON public."tax_deadline_notification_history"
  FOR SELECT
  USING (
    "tenant_id" = app.current_tenant_id()
    AND app.current_actor_type() = 'STAFF'
    AND EXISTS (
      SELECT 1
        FROM public."staff_user" staff
        JOIN public."staff_role" role
          ON role.staff_user_id = staff.id
       WHERE staff.id = app.current_actor_id()
         AND staff.tenant_id = "tax_deadline_notification_history"."tenant_id"
         AND staff.active = TRUE
         AND role.role IN ('ADMIN', 'PARTNER')
    )
  );

REVOKE ALL ON TABLE public."tax_deadline_notification_history" FROM PUBLIC;
REVOKE ALL ON TABLE public."tax_deadline_notification_history" FROM taxtronik_app;

-- Reconcile existing known resource links before installing the fail-closed
-- trigger. Unknown legacy links are not rewritten to a neutral scope; the new
-- policies keep them invisible.
DROP TRIGGER IF EXISTS "00_notification_derive_client_scope"
  ON public."notification";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."tax_notice" source
 WHERE notification."resource_type" = 'tax_notice'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."client_reminder" source
 WHERE notification."resource_type" = 'client_reminder'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."pending_binder" source
 WHERE notification."resource_type" = 'pending_binder'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."tax_deadline" source
 WHERE notification."resource_type" = 'tax_deadline'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."request" source
 WHERE notification."resource_type" = 'request'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."invoice" source
 WHERE notification."resource_type" = 'invoice'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."gwg_check" source
 WHERE notification."resource_type" = 'gwg_check'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."power_of_attorney" source
 WHERE notification."resource_type" = 'power_of_attorney'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."phone_note" source
 WHERE notification."resource_type" = 'phone_note'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."id"
  FROM public."client" source
 WHERE notification."resource_type" = 'client'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."document" source
 WHERE notification."resource_type" = 'document'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."appointment" source
 WHERE notification."resource_type" = 'appointment'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."appointment_request" source
 WHERE notification."resource_type" = 'appointment_request'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."client_master_change_request" source
 WHERE notification."resource_type" = 'client_master_change_request'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."client_contact" source
 WHERE notification."resource_type" = 'client_contact'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = source."client_id"
  FROM public."client_consent" source
 WHERE notification."resource_type" = 'client_consent'
   AND notification."resource_id" = source."id"::TEXT
   AND notification."tenant_id" = source."tenant_id";

-- Abgeleitete Fachressourcen besitzen die Mandanten-ID nicht immer selbst.
-- Der Backfill folgt deshalb ausschließlich den tenantgleichen FK-Ketten; er
-- liest weder IDs aus hrefs noch aus Notification-Klartexten heraus.
UPDATE public."notification" notification
   SET "client_id" = reminder."client_id"
  FROM public."client_reminder_note" note
  JOIN public."client_reminder" reminder
    ON reminder."id" = note."reminder_id"
   AND reminder."tenant_id" = note."tenant_id"
 WHERE notification."resource_type" = 'client_reminder_note'
   AND notification."resource_id" = note."id"::TEXT
   AND notification."tenant_id" = note."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = invite."client_id"
  FROM public."gwg_onboarding_invite" invite
 WHERE notification."resource_type" = 'gwg_onboarding_invite'
   AND notification."resource_id" = invite."id"::TEXT
   AND notification."tenant_id" = invite."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = check_row."client_id"
  FROM public."gwg_id_document" id_document
  JOIN public."gwg_check" check_row
    ON check_row."id" = id_document."gwg_check_id"
 WHERE notification."resource_type" = 'gwg_id_document'
   AND notification."resource_id" = id_document."id"::TEXT
   AND notification."tenant_id" = check_row."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = analysis."client_id"
  FROM public."risk_marking" marking
  JOIN public."risk_analysis" analysis
    ON analysis."id" = marking."analysis_id"
   AND analysis."tenant_id" = marking."tenant_id"
 WHERE notification."resource_type" = 'risk_marking'
   AND notification."resource_id" = marking."id"::TEXT
   AND notification."tenant_id" = marking."tenant_id";

UPDATE public."notification" notification
   SET "client_id" = resolved."client_id"
  FROM (
    SELECT result."id",
           result."tenant_id",
           COALESCE(request_analysis."client_id", marking_analysis."client_id", shelf."client_id")
             AS "client_id"
      FROM public."risk_research_result" result
      LEFT JOIN public."risk_research_request" research_request
        ON research_request."id" = result."research_request_id"
       AND research_request."tenant_id" = result."tenant_id"
      LEFT JOIN public."risk_analysis" request_analysis
        ON request_analysis."id" = research_request."analysis_id"
       AND request_analysis."tenant_id" = result."tenant_id"
      LEFT JOIN public."risk_marking" marking
        ON marking."id" = result."marking_id"
       AND marking."tenant_id" = result."tenant_id"
      LEFT JOIN public."risk_analysis" marking_analysis
        ON marking_analysis."id" = marking."analysis_id"
       AND marking_analysis."tenant_id" = result."tenant_id"
      LEFT JOIN public."document" shelf
        ON shelf."id" = result."shelf_document_id"
       AND shelf."tenant_id" = result."tenant_id"
  ) resolved
 WHERE notification."resource_type" = 'risk_research_result'
   AND notification."resource_id" = resolved."id"::TEXT
   AND notification."tenant_id" = resolved."tenant_id"
   AND resolved."client_id" IS NOT NULL;

-- Die historische Einzel-FK auf staff_id beweist keine Tenant-Paarung. Ein
-- bereits inkonsistenter Altbestand wird nicht still umgehängt.
DO $notification_staff_scope_audit$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."notification" notification
      JOIN public."staff_user" staff ON staff."id" = notification."staff_id"
     WHERE notification."staff_id" IS NOT NULL
       AND staff."tenant_id" IS DISTINCT FROM notification."tenant_id"
  ) THEN
    RAISE EXCEPTION 'notification.staff_id verweist tenantübergreifend auf einen Mitarbeiter'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END;
$notification_staff_scope_audit$;

DROP TRIGGER IF EXISTS "00_tenant_client_pair_integrity"
  ON public."notification";
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF "tenant_id", "client_id"
  ON public."notification"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

CREATE OR REPLACE FUNCTION app.notification_resource_scope(
  p_tenant_id UUID,
  p_resource_type TEXT,
  p_resource_id TEXT,
  OUT resource_is_known BOOLEAN,
  OUT resource_was_found BOOLEAN,
  OUT resolved_client_id UUID
) RETURNS RECORD
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Die Hilfsfunktion ist Teil einer RLS-Policy und deshalb für die App-Rolle
  -- ausführbar. Direkte Aufrufe dürfen daraus keinen tenantfremden
  -- Existenz-/Mandanten-Orakelpfad machen.
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    resource_is_known := FALSE;
    resource_was_found := FALSE;
    resolved_client_id := NULL;
    RETURN;
  END IF;

  resource_is_known := TRUE;
  resource_was_found := FALSE;
  resolved_client_id := NULL;

  -- Eine vollständig ressourcenlose Notification ist ein expliziter
  -- kanzleiweiter Hinweis. Halb gesetzte Links sind dagegen nie gültig.
  IF p_resource_type IS NULL AND p_resource_id IS NULL THEN
    resource_was_found := TRUE;
    RETURN;
  ELSIF p_resource_type IS NULL THEN
    resource_is_known := FALSE;
    RETURN;
  END IF;

  CASE p_resource_type
    WHEN 'tax_notice' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."tax_notice" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client_reminder' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."client_reminder" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'pending_binder' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."pending_binder" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'tax_deadline' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."tax_deadline" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'request' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."request" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'invoice' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."invoice" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'gwg_check' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."gwg_check" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'power_of_attorney' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."power_of_attorney" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'phone_note' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."phone_note" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client' THEN
      SELECT source."id" INTO resolved_client_id
        FROM public."client" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'document' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."document" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'appointment' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."appointment" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'appointment_request' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."appointment_request" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client_master_change_request' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."client_master_change_request" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client_contact' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."client_contact" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client_consent' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."client_consent" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'client_reminder_note' THEN
      SELECT reminder."client_id" INTO resolved_client_id
        FROM public."client_reminder_note" note
        JOIN public."client_reminder" reminder
          ON reminder."id" = note."reminder_id"
         AND reminder."tenant_id" = note."tenant_id"
       WHERE note."tenant_id" = p_tenant_id
         AND note."id"::TEXT = p_resource_id;
    WHEN 'gwg_onboarding_invite' THEN
      SELECT source."client_id" INTO resolved_client_id
        FROM public."gwg_onboarding_invite" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'gwg_id_document' THEN
      SELECT check_row."client_id" INTO resolved_client_id
        FROM public."gwg_id_document" id_document
        JOIN public."gwg_check" check_row
          ON check_row."id" = id_document."gwg_check_id"
       WHERE check_row."tenant_id" = p_tenant_id
         AND id_document."id"::TEXT = p_resource_id;
    WHEN 'risk_marking' THEN
      SELECT analysis."client_id" INTO resolved_client_id
        FROM public."risk_marking" marking
        JOIN public."risk_analysis" analysis
          ON analysis."id" = marking."analysis_id"
         AND analysis."tenant_id" = marking."tenant_id"
       WHERE marking."tenant_id" = p_tenant_id
         AND marking."id"::TEXT = p_resource_id;
    WHEN 'risk_research_result' THEN
      SELECT COALESCE(request_analysis."client_id", marking_analysis."client_id", shelf."client_id")
        INTO resolved_client_id
        FROM public."risk_research_result" result
        LEFT JOIN public."risk_research_request" research_request
          ON research_request."id" = result."research_request_id"
         AND research_request."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" request_analysis
          ON request_analysis."id" = research_request."analysis_id"
         AND request_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_marking" marking
          ON marking."id" = result."marking_id"
         AND marking."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" marking_analysis
          ON marking_analysis."id" = marking."analysis_id"
         AND marking_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."document" shelf
          ON shelf."id" = result."shelf_document_id"
         AND shelf."tenant_id" = result."tenant_id"
       WHERE result."tenant_id" = p_tenant_id
         AND result."id"::TEXT = p_resource_id;
    WHEN 'vacation_request' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public."vacation_request" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'absence' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public."absence" source
       WHERE source."tenant_id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    WHEN 'tenant' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public."tenant" source
       WHERE source."id" = p_tenant_id
         AND source."id"::TEXT = p_resource_id;
    -- Diese technischen Quellen sind tenantweit und besitzen teils keinen
    -- stabilen Datenbankdatensatz (z. B. einen Backup-Objektschlüssel). Ihre
    -- explizite Positivliste verhindert, dass ein neuer, versehentlich nicht
    -- klassifizierter Fachtyp still als global sichtbar wird.
    WHEN 'audit_log', 'backup_drill', 'mail', 'staff_user', 'tax_news_item' THEN
      resource_was_found := TRUE;
      RETURN;
    ELSE
      resource_is_known := FALSE;
      RETURN;
  END CASE;

  resource_was_found := FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION app.notification_neutral_scope_is_valid(
  p_tenant_id UUID,
  p_resource_type TEXT,
  p_resource_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT scope.resource_is_known
         AND scope.resource_was_found
         AND scope.resolved_client_id IS NULL
    FROM app.notification_resource_scope(
      p_tenant_id,
      p_resource_type,
      p_resource_id
    ) scope
$$;

CREATE OR REPLACE FUNCTION app.notification_resource_matches_client(
  p_tenant_id UUID,
  p_resource_type TEXT,
  p_resource_id TEXT,
  p_client_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT scope.resource_is_known
         AND scope.resource_was_found
         AND scope.resolved_client_id = p_client_id
    FROM app.notification_resource_scope(
      p_tenant_id,
      p_resource_type,
      p_resource_id
    ) scope
$$;

-- Entspricht packages/db/src/staff-client-access.ts:
-- ADMIN/PARTNER immer; im OPEN-Modus alle aktiven Mitarbeiter bei nicht
-- vertraulichen Mandanten; sonst BERUFSTRAEGER-/HAUPTBEARBEITER-Zuordnung.
CREATE OR REPLACE FUNCTION app.notification_staff_can_access_client(
  p_tenant_id UUID,
  p_staff_id UUID,
  p_client_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_tenant_id = app.current_tenant_id()
         AND p_staff_id = app.current_actor_id()
         AND EXISTS (
    SELECT 1
      FROM public."staff_user" staff
      JOIN public."client" client
        ON client."id" = p_client_id
       AND client."tenant_id" = p_tenant_id
     WHERE staff."id" = p_staff_id
       AND staff."tenant_id" = p_tenant_id
       AND staff."active" = TRUE
       AND (
         EXISTS (
           SELECT 1
             FROM public."staff_role" staff_role
            WHERE staff_role."staff_user_id" = staff."id"
              AND staff_role."role" IN (
                'ADMIN'::public."staff_role_name",
                'PARTNER'::public."staff_role_name"
              )
         )
         OR (
           client."vertraulich" = FALSE
           AND NOT EXISTS (
             SELECT 1
               FROM public."tenant_setting" setting
              WHERE setting."tenant_id" = p_tenant_id
                AND setting."key" = 'access'
                AND setting."value" ->> 'clientAccessMode' = 'RESTRICTED'
           )
         )
         OR EXISTS (
           SELECT 1
             FROM public."client_responsibility" responsibility
            WHERE responsibility."tenant_id" = p_tenant_id
              AND responsibility."client_id" = p_client_id
              AND responsibility."staff_id" = p_staff_id
              AND responsibility."role" IN (
                'BERUFSTRAEGER'::public."client_responsibility_role",
                'HAUPTBEARBEITER'::public."client_responsibility_role"
              )
         )
       )
  )
$$;

CREATE OR REPLACE FUNCTION app.notification_staff_actor_is_active(
  p_tenant_id UUID,
  p_staff_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_tenant_id = app.current_tenant_id()
         AND p_staff_id = app.current_actor_id()
         AND EXISTS (
    SELECT 1
      FROM public."staff_user" staff
     WHERE staff."id" = p_staff_id
       AND staff."tenant_id" = p_tenant_id
       AND staff."active" = TRUE
  )
$$;

-- Bekannte Fachlinks können client_id weder vergessen noch fälschen. Die
-- Quellzeile wird bis Transaktionsende gegen paralleles Löschen gesperrt.
CREATE OR REPLACE FUNCTION app.notification_derive_client_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  resource_was_found BOOLEAN := FALSE;
  expected_client_id UUID;
  staff_tenant_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."client_id" IS DISTINCT FROM OLD."client_id"
    OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id"
    OR NEW."resource_type" IS DISTINCT FROM OLD."resource_type"
    OR NEW."resource_id" IS DISTINCT FROM OLD."resource_id"
  ) THEN
    RAISE EXCEPTION 'Notification-Scope und Ressourcenlink sind unveränderlich'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."resource_type" IS NULL AND NEW."resource_id" IS NULL THEN
    resource_was_found := TRUE;
  ELSIF NEW."resource_type" IS NULL THEN
    RAISE EXCEPTION 'Notification-Ressourcenlink ist nur halb gesetzt'
      USING ERRCODE = 'invalid_parameter_value';
  ELSE
  CASE NEW."resource_type"
    WHEN 'tax_notice' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."tax_notice" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_reminder' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_reminder" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'pending_binder' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."pending_binder" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'tax_deadline' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."tax_deadline" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'invoice' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."invoice" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'gwg_check' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."gwg_check" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'power_of_attorney' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."power_of_attorney" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'phone_note' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."phone_note" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client' THEN
      SELECT source."id" INTO expected_client_id
        FROM public."client" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'document' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."document" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'appointment' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."appointment" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'appointment_request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."appointment_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_master_change_request' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_master_change_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_contact' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_contact" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_consent' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."client_consent" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'client_reminder_note' THEN
      SELECT reminder."client_id" INTO expected_client_id
        FROM public."client_reminder_note" note
        JOIN public."client_reminder" reminder
          ON reminder."id" = note."reminder_id"
         AND reminder."tenant_id" = note."tenant_id"
       WHERE note."tenant_id" = NEW."tenant_id"
         AND note."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF note, reminder;
    WHEN 'gwg_onboarding_invite' THEN
      SELECT source."client_id" INTO expected_client_id
        FROM public."gwg_onboarding_invite" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'gwg_id_document' THEN
      SELECT check_row."client_id" INTO expected_client_id
        FROM public."gwg_id_document" id_document
        JOIN public."gwg_check" check_row
          ON check_row."id" = id_document."gwg_check_id"
       WHERE check_row."tenant_id" = NEW."tenant_id"
         AND id_document."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF id_document, check_row;
    WHEN 'risk_marking' THEN
      SELECT analysis."client_id" INTO expected_client_id
        FROM public."risk_marking" marking
        JOIN public."risk_analysis" analysis
          ON analysis."id" = marking."analysis_id"
         AND analysis."tenant_id" = marking."tenant_id"
       WHERE marking."tenant_id" = NEW."tenant_id"
         AND marking."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF marking, analysis;
    WHEN 'risk_research_result' THEN
      SELECT COALESCE(request_analysis."client_id", marking_analysis."client_id", shelf."client_id")
        INTO expected_client_id
        FROM public."risk_research_result" result
        LEFT JOIN public."risk_research_request" research_request
          ON research_request."id" = result."research_request_id"
         AND research_request."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" request_analysis
          ON request_analysis."id" = research_request."analysis_id"
         AND request_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_marking" marking
          ON marking."id" = result."marking_id"
         AND marking."tenant_id" = result."tenant_id"
        LEFT JOIN public."risk_analysis" marking_analysis
          ON marking_analysis."id" = marking."analysis_id"
         AND marking_analysis."tenant_id" = result."tenant_id"
        LEFT JOIN public."document" shelf
          ON shelf."id" = result."shelf_document_id"
         AND shelf."tenant_id" = result."tenant_id"
       WHERE result."tenant_id" = NEW."tenant_id"
         AND result."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE OF result;
    WHEN 'vacation_request' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."vacation_request" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'absence' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."absence" source
       WHERE source."tenant_id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'tenant' THEN
      SELECT NULL::UUID INTO expected_client_id
        FROM public."tenant" source
       WHERE source."id" = NEW."tenant_id"
         AND source."id"::TEXT = NEW."resource_id"
       FOR KEY SHARE;
    WHEN 'audit_log', 'backup_drill', 'mail', 'staff_user', 'tax_news_item' THEN
      resource_was_found := TRUE;
    ELSE
      RAISE EXCEPTION 'Unklassifizierter Notification-Ressourcentyp: %',
        NEW."resource_type"
        USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  END IF;

  IF NOT resource_was_found THEN
    resource_was_found := FOUND;
  END IF;
  IF NOT resource_was_found THEN
    RAISE EXCEPTION 'Bekannte Notification-Ressource existiert nicht im Tenant-Scope (%:%)',
      NEW."resource_type", NEW."resource_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."client_id" IS NOT NULL
     AND NEW."client_id" IS DISTINCT FROM expected_client_id THEN
    RAISE EXCEPTION 'Notification.client_id widerspricht dem bekannten Fachobjekt'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW."client_id" := expected_client_id;

  IF NEW."staff_id" IS NOT NULL THEN
    SELECT staff."tenant_id" INTO staff_tenant_id
      FROM public."staff_user" staff
     WHERE staff."id" = NEW."staff_id"
     FOR KEY SHARE;
    IF NOT FOUND OR staff_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
      RAISE EXCEPTION 'Notification.staff_id gehört nicht zum Tenant-Scope'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "00_notification_derive_client_scope"
  BEFORE INSERT OR UPDATE OF "tenant_id", "client_id", "resource_type", "resource_id", "staff_id"
  ON public."notification"
  FOR EACH ROW EXECUTE FUNCTION app.notification_derive_client_scope();

CREATE OR REPLACE FUNCTION app.resolve_client_contact_notifications(
  p_tenant_id UUID,
  p_resource_type TEXT,
  p_resource_id TEXT,
  p_resolved_at TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  contact_client_id UUID;
  scope RECORD;
  resolved_count INTEGER;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'
     OR app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Nur ein tenantgebundener Portal-Kontakt darf diese Notification-Auflösung ausführen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT contact."client_id" INTO contact_client_id
    FROM public."client_contact" contact
   WHERE contact."id" = app.current_actor_id()
     AND contact."tenant_id" = p_tenant_id
     AND contact."active" = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aktiver Portal-Kontakt nicht gefunden'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO scope
    FROM app.notification_resource_scope(p_tenant_id, p_resource_type, p_resource_id);
  IF NOT scope.resource_is_known
     OR NOT scope.resource_was_found
     OR scope.resolved_client_id IS DISTINCT FROM contact_client_id THEN
    RAISE EXCEPTION 'Notification-Ressource gehört nicht zum Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public."notification"
     SET "read_at" = p_resolved_at
   WHERE "tenant_id" = p_tenant_id
     AND "client_id" = contact_client_id
     AND "resource_type" = p_resource_type
     AND "resource_id" = p_resource_id
     AND "read_at" IS NULL;
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  RETURN resolved_count;
END;
$$;

REVOKE ALL ON FUNCTION app.notification_resource_scope(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_neutral_scope_is_valid(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_resource_matches_client(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_staff_can_access_client(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_staff_actor_is_active(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.notification_derive_client_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_client_contact_notifications(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.notification_resource_scope(UUID, TEXT, TEXT) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.notification_neutral_scope_is_valid(UUID, TEXT, TEXT) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.notification_resource_matches_client(UUID, TEXT, TEXT, UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.notification_staff_can_access_client(UUID, UUID, UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.notification_staff_actor_is_active(UUID, UUID) TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.notification_derive_client_scope() TO taxtronik_app;
GRANT EXECUTE ON FUNCTION app.resolve_client_contact_notifications(UUID, TEXT, TEXT, TIMESTAMPTZ) TO taxtronik_app;

ALTER TABLE public."notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."notification" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_isolation" ON public."notification";
DROP POLICY IF EXISTS "notification_select" ON public."notification";
DROP POLICY IF EXISTS "notification_insert" ON public."notification";
DROP POLICY IF EXISTS "notification_update" ON public."notification";
DROP POLICY IF EXISTS "notification_delete" ON public."notification";

CREATE POLICY "notification_select"
  ON public."notification"
  FOR SELECT
  USING (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND ("staff_id" IS NULL OR "staff_id" = app.current_actor_id())
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
    )
  );

CREATE POLICY "notification_insert"
  ON public."notification"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
      OR (
        app.current_actor_type() = 'CLIENT_CONTACT'
        AND EXISTS (
          SELECT 1
            FROM public."client_contact" contact
           WHERE contact."id" = app.current_actor_id()
             AND contact."tenant_id" = "notification"."tenant_id"
             AND contact."client_id" = "notification"."client_id"
             AND contact."active" = TRUE
        )
        AND app.notification_resource_matches_client(
          "tenant_id",
          "resource_type",
          "resource_id",
          "client_id"
        )
      )
    )
  );

CREATE POLICY "notification_update"
  ON public."notification"
  FOR UPDATE
  USING (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND ("staff_id" IS NULL OR "staff_id" = app.current_actor_id())
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
    )
  )
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND ("staff_id" IS NULL OR "staff_id" = app.current_actor_id())
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
    )
  );

CREATE POLICY "notification_delete"
  ON public."notification"
  FOR DELETE
  USING (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND ("staff_id" IS NULL OR "staff_id" = app.current_actor_id())
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
    )
  );


-- The behavior is now canonical. Converge only the exact attested legacy
-- checksums and prove that both rows reached the repository state.
UPDATE public._prisma_migrations AS ledger
   SET checksum = known.canonical_checksum
  FROM known_late_security_drift AS known
 WHERE ledger.migration_name = known.migration_name
   AND ledger.checksum = known.legacy_checksum
   AND ledger.finished_at IS NOT NULL
   AND ledger.rolled_back_at IS NULL;

DO $late_security_drift_convergence$
DECLARE
  invalid_rows TEXT;
BEGIN
  SELECT string_agg(known.migration_name, ', ' ORDER BY known.migration_name)
    INTO invalid_rows
    FROM known_late_security_drift AS known
    LEFT JOIN public._prisma_migrations AS ledger
      ON ledger.migration_name = known.migration_name
     AND ledger.finished_at IS NOT NULL
     AND ledger.rolled_back_at IS NULL
   WHERE ledger.migration_name IS NULL
      OR ledger.checksum <> known.canonical_checksum;

  IF invalid_rows IS NOT NULL THEN
    RAISE EXCEPTION 'Late security migration checksums did not converge: %', invalid_rows
      USING ERRCODE = 'data_exception';
  END IF;
END;
$late_security_drift_convergence$;

COMMIT;
