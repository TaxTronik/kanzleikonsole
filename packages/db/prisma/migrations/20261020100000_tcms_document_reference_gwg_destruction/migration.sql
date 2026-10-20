-- TCMS-NACHWEIS-001 / GWG-RETENTION-DESTRUCTION-001.
--
-- RT3B-K-01 (TCMS Stufe 3, Angriffsdurchlauf 3b): Ein als Nachweis des
-- Tax-CMS gebundenes Dokument ließ sich in der Ablage zum GwG-Beleg
-- umklassifizieren und lief dann in die GwG-Pflichtvernichtung. Deren Claim
-- kannte die Bindung nicht; die Aktion löschte die Objektversionen, erst die
-- DB-Vernichtung danach scheiterte an der Bindung – die Nachweis-Bytes waren
-- verloren, der Verweis blieb offen.
--
-- Änderung (Schicht b; Schicht a ist die Umklassifizierung der Ablage,
-- Schicht c die Vernichtungsaktion):
--   - app.assert_gwg_document_destruction_due weist ein Dokument mit offener
--     tcms_document_reference ab (restrict_violation, Marker „als Nachweis im
--     Tax-CMS verknüpft“), nach der Dokumentsperre und vor Klassifikation und
--     Frist. app.destroy_gwg_document_versions ruft den Claim zuerst und weist
--     damit ebenso ab. Signatur, SECURITY DEFINER und Rechte bleiben (CREATE
--     OR REPLACE), damit gelten die GwG- und Restore-Invarianten unverändert.
--   - document_tcms_reference_scope_guard weist für jede Rolle den Wechsel
--     eines gebundenen Dokuments in einen Rahmen ab, in dem es nie hätte
--     verknüpft werden dürfen: Klassifikation GWG_EVIDENCE, PERSONNEL,
--     STAFF_PRIVATE, Lohnbezug, Onboarding- oder Formularbezug (dieselben
--     Bedingungen wie app.guard_tcms_document_reference beim Anlegen). Andere
--     Umklassifizierungen (etwa die Höherstufung nach GoBD) bleiben möglich.
-- Nebenläufigkeit: Das Anlegen einer Verknüpfung sperrt die Dokumentzeile
-- FOR SHARE, die Änderung der Dokumentzeile wartet darauf (und umgekehrt);
-- der Trigger bzw. der Guard sieht danach den committeten Stand.
-- Daten bleiben unverändert. Ein vor dieser Migration entstandenes gebundenes
-- GwG-Dokument bleibt gebunden; seine Vernichtung weist der Claim ab, bis die
-- Verknüpfung frei ist. RLS und Rechte bleiben unverändert.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.assert_gwg_document_destruction_due(uuid).sql
--   neu:      functions/app.guard_tcms_referenced_document_scope().sql
--   neu:      triggers/document.document_tcms_reference_scope_guard.sql
BEGIN;

CREATE OR REPLACE FUNCTION app.assert_gwg_document_destruction_due(p_document_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  document_tenant UUID;
  document_client UUID;
  document_classification public."document_classification";
  document_created TIMESTAMP;
  document_retention_until TIMESTAMP;
  document_deleted_at TIMESTAMPTZ;
  document_destroyed_at TIMESTAMPTZ;
  mandate_ended_at TIMESTAMP;
  client_allow_active BOOLEAN;
  client_onboarding_completed_at TIMESTAMPTZ;
  invite_id UUID;
  invite_check_id UUID;
  requested_at TIMESTAMPTZ;
  requested_by UUID;
  retention_start TIMESTAMP;
  now_utc TIMESTAMP := timezone('UTC', CURRENT_TIMESTAMP);
  has_verified_reference BOOLEAN;
BEGIN
  SELECT d."tenant_id", d."client_id", d."classification", d."created_at", d."retention_until",
         d."deleted_at", d."gwg_destroyed_at", c."mandate_ended_at",
         c."allow_active", c."onboarding_completed_at",
         inv."id", inv."gwg_check_id",
         d."gwg_destruction_requested_at", d."gwg_destruction_requested_by"
    INTO document_tenant, document_client, document_classification, document_created,
         document_retention_until, document_deleted_at, document_destroyed_at,
         mandate_ended_at, client_allow_active, client_onboarding_completed_at,
         invite_id, invite_check_id, requested_at, requested_by
    FROM public."document" d
    LEFT JOIN public."client" c
      ON c."id" = d."client_id" AND c."tenant_id" = d."tenant_id"
    LEFT JOIN public."gwg_onboarding_invite" inv
      ON inv."id" = d."gwg_onboarding_invite_id"
     AND inv."tenant_id" = d."tenant_id"
     AND inv."client_id" = d."client_id"
   WHERE d."id" = p_document_id
   FOR UPDATE OF d;

  IF document_tenant IS NULL THEN
    RAISE EXCEPTION 'GwG-Dokument nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;
  IF app.current_tenant_id() IS NULL OR document_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Dokument gehört nicht zum aktuellen Tenant.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('STAFF', 'SYSTEM') THEN
    RAISE EXCEPTION 'GwG-Vernichtung ist nur im Staff-/System-Kontext zulässig.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() = 'STAFF' AND requested_by IS NULL THEN
    RAISE EXCEPTION 'GwG-Vernichtungsabsicht wurde keinem Staff zugeordnet.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- TCMS-NACHWEIS-001 (RT3B-K-01): Ein Dokument, auf das ein offener Verweis
  -- des Tax-CMS zeigt (Nachweis einer Durchführung, Anlage einer
  -- Ereignismeldung), wird nicht vernichtet – unabhängig von Klassifikation
  -- und Frist und vor jedem Object-Store-Löschen der Aktion. Eigenes Statement
  -- nach der Dokumentsperre: Unter READ COMMITTED sieht es eine Verknüpfung,
  -- die während des Wartens auf die Sperre committet wurde; eine spätere
  -- wartet auf die Sperre (FOR SHARE im Guard der Verknüpfung).
  IF EXISTS (
    SELECT 1
      FROM public."tcms_document_reference" r
     WHERE r."document_id" = p_document_id
       AND r."tenant_id" = document_tenant
       AND r."released_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, GwG-Vernichtung gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF document_classification <> 'GWG_EVIDENCE' OR requested_at IS NULL THEN
    RAISE EXCEPTION 'GwG-Vernichtung wurde nicht ordnungsgemäß angefordert.' USING ERRCODE = 'check_violation';
  END IF;

  -- Preserve the canonical lock order behind the already locked document.
  PERFORM 1 FROM public."client" c
   WHERE c."id" = document_client AND c."tenant_id" = document_tenant
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_onboarding_invite" inv
   WHERE inv."id" = invite_id
     AND inv."tenant_id" = document_tenant
     AND inv."client_id" = document_client
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_id_document" gid
   WHERE gid."document_id" = p_document_id
   ORDER BY gid."id"
   FOR UPDATE NOWAIT;
  PERFORM 1 FROM public."gwg_check" gc
   WHERE gc."tenant_id" = document_tenant
     AND gc."client_id" = document_client
     AND (
       gc."id" = invite_check_id
       OR gc."id" IN (
          SELECT gid."gwg_check_id" FROM public."gwg_id_document" gid
          WHERE gid."document_id" = p_document_id
       )
     )
   ORDER BY gc."id"
   FOR UPDATE NOWAIT;

  -- Re-read all relationship facts after the relation locks. Under READ
  -- COMMITTED this observes writers that committed while the NOWAIT locks were
  -- acquired and closes the same TOCTOU window as the canonical predecessor.
  SELECT c."mandate_ended_at", c."allow_active", c."onboarding_completed_at",
         inv."id", inv."gwg_check_id"
    INTO mandate_ended_at, client_allow_active, client_onboarding_completed_at,
         invite_id, invite_check_id
    FROM public."document" d
    LEFT JOIN public."client" c
      ON c."id" = d."client_id" AND c."tenant_id" = d."tenant_id"
    LEFT JOIN public."gwg_onboarding_invite" inv
      ON inv."id" = d."gwg_onboarding_invite_id"
     AND inv."tenant_id" = d."tenant_id"
     AND inv."client_id" = d."client_id"
   WHERE d."id" = p_document_id;

  IF document_deleted_at IS NOT NULL OR document_destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GwG-Dokument ist bereits gelöscht oder vernichtet.' USING ERRCODE = 'check_violation';
  END IF;
  IF document_retention_until IS NULL OR document_retention_until > now_utc THEN
    RAISE EXCEPTION 'Object-Lock-Aufbewahrung ist nicht nachweisbar abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  retention_start := mandate_ended_at;
  IF retention_start IS NULL THEN
    -- allow_active/onboarding_completed_at are durable evidence that a business
    -- relationship existed even if a later GwG expiry deactivated the client.
    IF COALESCE(client_allow_active, FALSE) OR client_onboarding_completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'GwG-Beleg gehört zu einer bestehenden oder früher etablierten Geschäftsbeziehung; Mandatsende fehlt.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT EXISTS (
      SELECT 1
        FROM public."gwg_check" gc
       WHERE gc."destroyed_at" IS NULL
         AND gc."tenant_id" = document_tenant
         AND gc."client_id" = document_client
         AND (
           gc."id" = invite_check_id
           OR EXISTS (
              SELECT 1 FROM public."gwg_id_document" gid
              WHERE gid."document_id" = p_document_id
                AND gid."gwg_check_id" = gc."id"
           )
         )
         AND (gc."status" = 'VERIFIED' OR gc."verified_at" IS NOT NULL)
    ) INTO has_verified_reference;

    IF has_verified_reference THEN
      RAISE EXCEPTION 'GwG-Beleg wird von einer verifizierten Geschäftsbeziehung benötigt.' USING ERRCODE = 'check_violation';
    END IF;

    -- In the remaining case no relationship was ever established. This covers
    -- stale DRAFT/IN_REVIEW first checks as well as REJECTED/EXPIRED checks and
    -- unlinked evidence; the finding year is the document creation year.
    retention_start := document_created;
  END IF;

  IF retention_start IS NULL THEN
    RAISE EXCEPTION 'Gesetzlicher GwG-Fristbeginn ist nicht belegt.' USING ERRCODE = 'check_violation';
  END IF;
  IF now_utc < make_date(EXTRACT(YEAR FROM retention_start)::INTEGER + 6, 1, 1)::TIMESTAMP THEN
    RAISE EXCEPTION 'Reguläre fünfjährige GwG-Aufbewahrungsfrist ist noch nicht abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN;
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION 'GwG-Belegrelationen werden parallel bearbeitet; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
END;
$function$;

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
  IF EXISTS (
    SELECT 1
      FROM public.tcms_document_reference r
     WHERE r.document_id = OLD.id
       AND r.tenant_id = OLD.tenant_id
       AND r.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'document: als Nachweis im Tax-CMS verknüpft, Umklassifizieren gesperrt'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER document_tcms_reference_scope_guard BEFORE UPDATE OF classification, requires_payroll_access, gwg_onboarding_invite_id, form_submission_id ON public.document FOR EACH ROW WHEN ((((new.classification IS DISTINCT FROM old.classification) AND (new.classification = ANY (ARRAY['GWG_EVIDENCE'::document_classification, 'PERSONNEL'::document_classification, 'STAFF_PRIVATE'::document_classification]))) OR (new.requires_payroll_access AND (NOT old.requires_payroll_access)) OR ((new.gwg_onboarding_invite_id IS NOT NULL) AND (new.gwg_onboarding_invite_id IS DISTINCT FROM old.gwg_onboarding_invite_id)) OR ((new.form_submission_id IS NOT NULL) AND (new.form_submission_id IS DISTINCT FROM old.form_submission_id)))) EXECUTE FUNCTION app.guard_tcms_referenced_document_scope();

COMMIT;
