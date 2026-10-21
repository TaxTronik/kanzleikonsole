-- TCMS-NACHWEIS-001 / GWG-RETENTION-DESTRUCTION-001.
--
-- kk-tcms-s11, Produktentscheidung (Rey Koxha, 21.10.2026; fachlich
-- ungeprüft): Ein GwG-Beleg, der als Nachweis des Tax-CMS gebunden ist oder war
-- (heute nur Altbestand: neue Bindungen von GwG-Belegen weist der Guard der
-- Verknüpfung weiter ab), gilt zugleich als steuerliche Unterlage. Seine
-- Aufbewahrung steigt auf die nächsthöhere Klasse des vorhandenen Modells
-- (Rang NONE < GWG < GOBD): GOBD mit dem Intervall der Steuerunterlage
-- (GOBD_TAX, zehn Jahre), berechnet wie die GoBD-Höherstufung der Ablage
-- (retentionUntilForYears(10, Dokumentanlage)): 1. Januar des Jahres
-- Anlage + 11, 00:00 UTC. Die GwG-Vernichtung ist erst fällig, wenn beide
-- Fristen abgelaufen sind (Maximum), auch nach der Freigabe der Bindung.
--
--   - app.tcms_gwg_evidence_tax_retention_until: der Stichtag.
--   - app.raise_tcms_gwg_evidence_retention: hebt document.retention_until
--     eines GwG-Belegs mit (auch freigegebenem) Verweis an, nie herab; nicht
--     bei fehlendem Aufbewahrungsende (NULL bleibt fail closed) und nicht bei
--     vorgemerkten oder vernichteten Belegen (eingefroren).
--   - Trigger tcms_document_reference_gwg_retention: dasselbe bei jeder neuen
--     Bindung (Rückfallebene, falls die Abweisung von GwG-Belegen entfällt).
--   - app.assert_gwg_document_destruction_due: weist einen Beleg mit (auch
--     freigegebenem) Verweis vor Ablauf der GoBD-Frist ab, unabhängig von
--     retention_until.
--   - app.destroy_gwg_document_versions: entfernt freigegebene Verweise vor
--     den Versionen. Deren Fremdschlüssel auf document_version (ohne Kaskade)
--     ließ den DB-Abschluss nach der Freigabe sonst scheitern – nachdem die
--     Aktion die Bytes schon gelöscht hatte.
--   - Datenänderung: Altbestand (GwG-Belege mit Verweis) einmalig anheben.
--
-- Erzeugt mit `pnpm db:sql:migration` aus packages/db/prisma/sql
-- (docs/development/kanonische-sql-quellen.md):
--   geändert: functions/app.assert_gwg_document_destruction_due(uuid).sql
--   geändert: functions/app.destroy_gwg_document_versions(uuid).sql
--   neu:      functions/app.raise_tcms_gwg_evidence_retention(uuid).sql
--   neu:      functions/app.tcms_document_reference_gwg_retention().sql
--   neu:      functions/app.tcms_gwg_evidence_tax_retention_until(timestamp).sql
--   neu:      triggers/tcms_document_reference.tcms_document_reference_gwg_retention.sql
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
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte (auch freigegeben), gilt zugleich als
  -- steuerliche Unterlage; vernichtet wird erst, wenn auch deren GoBD-Frist
  -- abgelaufen ist (Maximum beider Fristen). retention_until trägt sie in der
  -- Regel schon (app.raise_tcms_gwg_evidence_retention); diese Prüfung hält sie
  -- auch, wo das Aufbewahrungsende nicht angehoben werden konnte (vorgemerkter
  -- Beleg) oder später verändert wurde.
  IF now_utc < app.tcms_gwg_evidence_tax_retention_until(document_created)
     AND EXISTS (
       SELECT 1
         FROM public."tcms_document_reference" r
        WHERE r."document_id" = p_document_id
          AND r."tenant_id" = document_tenant
     ) THEN
    RAISE EXCEPTION 'GwG-Beleg ist als Nachweis des Tax-CMS zugleich steuerliche Unterlage; deren Aufbewahrungsfrist ist nicht abgelaufen.'
      USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION app.destroy_gwg_document_versions(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  deleted_count INTEGER;
BEGIN
  PERFORM app.assert_gwg_document_destruction_due(p_document_id);
  PERFORM set_config('app.gwg_destroy_document_id', p_document_id::TEXT, TRUE);
  -- TCMS-NACHWEIS-001 (kk-tcms-s11): Freigegebene Verweise des Tax-CMS zeigen
  -- über document_version_id (Fremdschlüssel ohne Kaskade) auf die Versionen.
  -- Der Claim hat unter der Dokumentsperre keine offene Verknüpfung gefunden und
  -- beide Fristen geprüft; die freigegebenen Verweise werden mit dem Beleg
  -- vernichtet. Sonst scheiterte der DB-Abschluss, nachdem die Aktion die Bytes
  -- schon gelöscht hat.
  DELETE FROM public."tcms_document_reference"
   WHERE "document_id" = p_document_id
     AND "released_at" IS NOT NULL;
  DELETE FROM public."document_version" WHERE "document_id" = p_document_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  UPDATE public."gwg_id_document" SET "document_id" = NULL
   WHERE "document_id" = p_document_id;
  UPDATE public."document"
     SET "title" = 'VERNICHTET',
         "mime_type" = 'application/x-destroyed',
         "deleted_at" = CURRENT_TIMESTAMP,
         "deleted_by_staff" = CASE
           WHEN app.current_actor_type() = 'STAFF' THEN app.current_actor_id()
           ELSE NULL
         END,
         "delete_reason" = 'GwG-Pflichtvernichtung nach Ablauf der Aufbewahrungsfrist',
         "gwg_destroyed_at" = CURRENT_TIMESTAMP,
         "gwg_destruction_error" = NULL,
         "shared_with_client_at" = NULL,
         "shared_by_staff" = NULL,
         "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = p_document_id;
  PERFORM set_config('app.gwg_destroy_document_id', '', TRUE);
  RETURN deleted_count;
END;
$function$;

CREATE OR REPLACE FUNCTION app.raise_tcms_gwg_evidence_retention(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  raised integer;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung (document.retention_until) steigt auf die
  -- GoBD-Frist der Steuerunterlage (app.tcms_gwg_evidence_tax_retention_until)
  -- und sinkt nie. Die GwG-Vernichtung prüft retention_until in Aktion und
  -- Claim; sie ist damit erst fällig, wenn beide Fristen abgelaufen sind, auch
  -- nach der Freigabe der Verknüpfung.
  -- Nicht angehoben werden: ein fehlendes Aufbewahrungsende (NULL hält die
  -- Vernichtung fail closed gesperrt; ein Datum würde sie später erlauben),
  -- vorgemerkte und vernichtete Belege (deren Felder sind eingefroren,
  -- app.guard_gwg_document_invite_and_claim) – für sie gilt dieselbe Frist über
  -- den Claim (app.assert_gwg_document_destruction_due).
  -- Läuft mit den Rechten des Aufrufers (RLS des Tenants); heben kann sie nur,
  -- verkürzen nie.
  UPDATE public.document d
     SET retention_until = app.tcms_gwg_evidence_tax_retention_until(d.created_at)
   WHERE d.id = p_document_id
     AND d.classification = 'GWG_EVIDENCE'
     AND d.gwg_destruction_requested_at IS NULL
     AND d.gwg_destroyed_at IS NULL
     AND d.retention_until IS NOT NULL
     AND d.retention_until < app.tcms_gwg_evidence_tax_retention_until(d.created_at)
     AND EXISTS (
       SELECT 1
         FROM public.tcms_document_reference r
        WHERE r.document_id = d.id
          AND r.tenant_id = d.tenant_id
     );
  GET DIAGNOSTICS raised = ROW_COUNT;
  RETURN raised;
END;
$function$;

CREATE OR REPLACE FUNCTION app.tcms_document_reference_gwg_retention()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  -- TCMS-NACHWEIS-001 (kk-tcms-s11): Bei der Bindung eines GwG-Belegs als
  -- Nachweis steigt seine Aufbewahrung auf die GoBD-Frist der Steuerunterlage
  -- (app.raise_tcms_gwg_evidence_retention). Heute weist der Guard der
  -- Verknüpfung GwG-Belege ab (Zugriffsbeschränkung); dieser Trigger hält die
  -- Regel für jeden Pfad, der sie künftig zulässt. Bestehende Bindungen
  -- (Altbestand) hebt die Migration 20261021150000 an.
  PERFORM app.raise_tcms_gwg_evidence_retention(NEW.document_id);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION app.tcms_gwg_evidence_tax_retention_until(p_created_at timestamp without time zone)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, der als
  -- Nachweis im Tax-CMS gebunden ist oder war, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung steigt auf die nächsthöhere Klasse des
  -- vorhandenen Modells (Rang GWG < GOBD, retag-policy.ts): GoBD mit dem
  -- Intervall der Steuerunterlage (GOBD_TAX, zehn Jahre), berechnet wie die
  -- GoBD-Höherstufung der Ablage (retentionUntilForYears(10, Anlage),
  -- packages/storage/src/service.ts): Jahr der Dokumentanlage plus zehn volle
  -- Jahre, Stichtag 1. Januar des Folgejahres, 00:00 UTC. NULL bleibt NULL.
  SELECT make_date(EXTRACT(YEAR FROM p_created_at)::integer + 11, 1, 1)::timestamp without time zone
$function$;

CREATE TRIGGER tcms_document_reference_gwg_retention AFTER INSERT ON public.tcms_document_reference FOR EACH ROW EXECUTE FUNCTION app.tcms_document_reference_gwg_retention();

-- Altbestand: GwG-Belege mit (auch freigegebenem) Verweis des Tax-CMS einmalig
-- anheben. Die Meldung nennt nur Anzahlen, keine Kennungen.
DO $migration$
DECLARE
  angehoben integer := 0;
  belege integer := 0;
  d RECORD;
BEGIN
  FOR d IN
    SELECT doc.id
      FROM public.document doc
     WHERE doc.classification = 'GWG_EVIDENCE'
       AND EXISTS (
         SELECT 1
           FROM public.tcms_document_reference r
          WHERE r.document_id = doc.id
            AND r.tenant_id = doc.tenant_id
       )
     ORDER BY doc.id
  LOOP
    belege := belege + 1;
    angehoben := angehoben + app.raise_tcms_gwg_evidence_retention(d.id);
  END LOOP;
  RAISE NOTICE 'TCMS-NACHWEIS-001: % GwG-Belege mit Verweis des Tax-CMS, % Aufbewahrungsenden angehoben.',
    belege, angehoben;
END
$migration$;

COMMIT;
