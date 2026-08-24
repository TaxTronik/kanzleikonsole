-- =============================================================================
-- Mandantenbezogene In-App-Notifications dauerhaft an den aktuellen
-- Mandantenzugriff binden.
--
-- Fachregeln: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
--
-- Der Klartext einer Notification darf nach einem Zuständigkeits- oder
-- Vertraulichkeitswechsel nicht allein deshalb sichtbar bleiben, weil er vor
-- dem Wechsel persistiert wurde. Der Client-Scope wird deshalb aus bekannten
-- Fachressourcen abgeleitet und durch RLS bei jedem Read/Update neu geprüft.
-- =============================================================================

BEGIN;

ALTER TABLE public."notification"
  ADD COLUMN "client_id" UUID;

-- Bestehende Links werden nur aus tatsächlich vorhandenen, tenantgleichen
-- Fachobjekten übernommen. Nicht mehr auflösbare Altlinks bleiben NULL und
-- werden von der neuen RLS-Policy für STAFF fail-closed ausgeblendet.
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

ALTER TABLE public."notification"
  ADD CONSTRAINT "notification_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES public."client"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "notification_tenant_client_staff_read_created_idx"
  ON public."notification"
  ("tenant_id", "client_id", "staff_id", "read_at", "created_at");

-- Gleicher race-sicherer Tenant-/Client-Guard wie für alle anderen Tabellen
-- mit diesem Spaltenpaar. Die generische Installationsmigration lief bereits,
-- bevor notification.client_id existierte, daher wird er hier nachgezogen.
CREATE TRIGGER "00_tenant_client_pair_integrity"
  BEFORE INSERT OR UPDATE OF "tenant_id", "client_id"
  ON public."notification"
  FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_client_pair_integrity();

-- Liefert für bekannte Notification-Ressourcen deren tatsächlichen Scope.
-- Ein separates found-Bit unterscheidet eine gültige interne Ressource mit
-- client_id=NULL von einem verwaisten oder gefälschten Link.
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

-- Portal-Kontakte dürfen Staff-Notifications nicht lesen. Die einzige heute
-- benötigte Auflösung (stornierte Terminanfrage) läuft über diese eng
-- begrenzte SECURITY-DEFINER-Funktion und liefert ausschließlich eine Anzahl.
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

DROP POLICY "notification_isolation" ON public."notification";

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

COMMIT;
