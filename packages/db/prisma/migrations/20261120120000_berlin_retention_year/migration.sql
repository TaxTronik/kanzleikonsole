-- GWG-RETENTION-DESTRUCTION-001, DOC-RETENTION-CLASS-001, TCMS-NACHWEIS-001.
-- Berliner Ankerjahr für UTC-kodierte Altdaten und echte Zeitpunkte.
-- Der Freigabezeitpunkt bleibt der 1. Januar um 00:00 UTC.
BEGIN;

CREATE OR REPLACE FUNCTION app.retention_until_from_utc(p_anchor_utc timestamp without time zone, p_years integer)
 RETURNS timestamp without time zone
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO 'pg_catalog'
AS $function$
  -- Prisma-TIMESTAMP speichert den Zeitpunkt als UTC-Wanduhrzeit. Der
  -- fachliche Anker gehört zum Berliner Kalenderjahr. Der gespeicherte
  -- Stichtag bleibt der folgende 1. Januar nach vollen Jahren, 00:00 UTC.
  SELECT make_date(
    EXTRACT(YEAR FROM (p_anchor_utc AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::integer + p_years + 1,
    1, 1
  )::timestamp without time zone
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
  SELECT app.retention_until_from_utc(p_created_at, 10)
$function$;

CREATE OR REPLACE FUNCTION app.raise_tcms_gwg_evidence_retention(p_document_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  raised integer;
  ziel timestamp;
BEGIN
  -- TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001 (kk-tcms-s11,
  -- Produktentscheidung Rey Koxha, 21.10.2026): Ein GwG-Beleg, auf den ein
  -- Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als steuerliche
  -- Unterlage. Seine Aufbewahrung (document.retention_until) steigt auf die
  -- GoBD-Frist der Steuerunterlage (app.tcms_gwg_evidence_tax_retention_until)
  -- und sinkt nie. Die GwG-Vernichtung prüft retention_until in Aktion und
  -- Claim; sie ist damit erst fällig, wenn beide Fristen abgelaufen sind, auch
  -- nach der Freigabe der Verknüpfung.
  -- RT3D-K-01 (kk-tcms-fix5): Ist das Mandat beendet, steigt das Ende
  -- zusätzlich auf das Ende der GwG-Frist: 1. Januar des sechsten Jahres nach
  -- dem Berliner Kalenderjahr des Mandatsendes, wie im Claim.
  -- Da retention_until dieser
  -- Belege nie sinkt (app.guard_tcms_referenced_document_retention), verkürzt
  -- ein später zurückgenommenes oder früher eingetragenes Mandatsende die
  -- Aufbewahrung nicht mehr; der Trigger client_tcms_gwg_evidence_retention
  -- hebt bei jedem neuen Mandatsende an.
  -- Nicht angehoben werden: ein fehlendes Aufbewahrungsende (NULL hält die
  -- Vernichtung fail closed gesperrt; ein Datum würde sie später erlauben),
  -- vorgemerkte und vernichtete Belege (deren Felder sind eingefroren,
  -- app.guard_gwg_document_invite_and_claim) – für sie gilt dieselbe Frist über
  -- den Claim (app.assert_gwg_document_destruction_due).
  -- Läuft mit den Rechten des Aufrufers (RLS des Tenants); heben kann sie nur,
  -- verkürzen nie.
  SELECT GREATEST(
           app.tcms_gwg_evidence_tax_retention_until(doc.created_at),
           app.retention_until_from_utc(c.mandate_ended_at AT TIME ZONE 'UTC', 5)
         )
    INTO ziel
    FROM public.document doc
    LEFT JOIN public.client c
      ON c.id = doc.client_id AND c.tenant_id = doc.tenant_id
   WHERE doc.id = p_document_id;
  UPDATE public.document d
     SET retention_until = ziel
   WHERE d.id = p_document_id
     AND d.classification = 'GWG_EVIDENCE'
     AND d.gwg_destruction_requested_at IS NULL
     AND d.gwg_destroyed_at IS NULL
     AND d.retention_until IS NOT NULL
     AND d.retention_until < ziel
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
         d."deleted_at", d."gwg_destroyed_at", c."mandate_ended_at" AT TIME ZONE 'UTC',
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
  SELECT c."mandate_ended_at" AT TIME ZONE 'UTC', c."allow_active", c."onboarding_completed_at",
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
  IF now_utc < app.retention_until_from_utc(retention_start, 5) THEN
    RAISE EXCEPTION 'Reguläre fünfjährige GwG-Aufbewahrungsfrist ist noch nicht abgelaufen.' USING ERRCODE = 'check_violation';
  END IF;

  RETURN;
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION 'GwG-Belegrelationen werden parallel bearbeitet; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
END;
$function$;

CREATE OR REPLACE FUNCTION app.destroy_gwg_check_locked_impl(p_check_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE
  check_tenant UUID;
  check_client UUID;
  check_status public."gwg_status";
  check_verified_at TIMESTAMP;
  check_destroyed_at TIMESTAMP;
  check_updated_at TIMESTAMP;
  mandate_ended_at TIMESTAMP;
  client_allow_active BOOLEAN;
  client_onboarding_completed_at TIMESTAMPTZ;
  retention_start TIMESTAMP;
  now_utc TIMESTAMP := timezone('UTC', CURRENT_TIMESTAMP);
  destroyed_at_utc TIMESTAMPTZ;
  owner_count INTEGER := 0;
  id_document_count INTEGER := 0;
  invite_count INTEGER := 0;
  open_document_count INTEGER := 0;
  latest_owner_at TIMESTAMP;
  latest_id_document_at TIMESTAMP;
  latest_invite_at TIMESTAMP;
BEGIN
  SELECT gc."tenant_id", gc."client_id"
    INTO check_tenant, check_client
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Prüfung nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  IF app.current_tenant_id() IS NULL OR check_tenant <> app.current_tenant_id() THEN
    RAISE EXCEPTION 'GwG-Prüfung gehört nicht zum aktuellen Tenant.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() IS NULL OR app.current_actor_type() NOT IN ('STAFF', 'SYSTEM') THEN
    RAISE EXCEPTION 'GwG-Vernichtung ist nur im Staff-/System-Kontext zulässig.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app.current_actor_type() = 'STAFF' AND (
    app.current_actor_id() IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."staff_user" su
       WHERE su."id" = app.current_actor_id()
         AND su."tenant_id" = check_tenant
         AND su."active" = TRUE
    )
  ) THEN
    RAISE EXCEPTION 'Aktiver Staff-Akteur für GwG-Vernichtung nicht nachgewiesen.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Preserve Client -> Check -> Invites -> ID documents -> owners lock order.
  SELECT timezone('UTC', c."mandate_ended_at"), c."allow_active", c."onboarding_completed_at"
    INTO mandate_ended_at, client_allow_active, client_onboarding_completed_at
    FROM public."client" c
   WHERE c."id" = check_client
     AND c."tenant_id" = check_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Mandant nicht gefunden.' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT gc."status", gc."verified_at", gc."destroyed_at", gc."updated_at"
    INTO check_status, check_verified_at, check_destroyed_at, check_updated_at
    FROM public."gwg_check" gc
   WHERE gc."id" = p_check_id
     AND gc."tenant_id" = check_tenant
     AND gc."client_id" = check_client
   FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GwG-Prüfung wurde parallel verschoben; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF check_destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GwG-Aufzeichnungen wurden bereits vernichtet.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM inv."id"
    FROM public."gwg_onboarding_invite" inv
   WHERE inv."gwg_check_id" = p_check_id
     AND inv."tenant_id" = check_tenant
     AND inv."client_id" = check_client
   ORDER BY inv."id"
   FOR UPDATE NOWAIT;
  PERFORM gid."id"
    FROM public."gwg_id_document" gid
   WHERE gid."gwg_check_id" = p_check_id
   ORDER BY gid."id"
   FOR UPDATE NOWAIT;
  PERFORM bo."id"
    FROM public."gwg_beneficial_owner" bo
   WHERE bo."gwg_check_id" = p_check_id
   ORDER BY bo."id"
   FOR UPDATE NOWAIT;

  SELECT COUNT(*)::INTEGER, MAX(bo."created_at")
    INTO owner_count, latest_owner_at
    FROM public."gwg_beneficial_owner" bo
   WHERE bo."gwg_check_id" = p_check_id;
  SELECT COUNT(*)::INTEGER, MAX(gid."created_at")
    INTO id_document_count, latest_id_document_at
    FROM public."gwg_id_document" gid
   WHERE gid."gwg_check_id" = p_check_id;
  SELECT COUNT(*)::INTEGER, MAX(inv."updated_at")
    INTO invite_count, latest_invite_at
    FROM public."gwg_onboarding_invite" inv
   WHERE inv."gwg_check_id" = p_check_id
     AND inv."tenant_id" = check_tenant
     AND inv."client_id" = check_client;

  SELECT COUNT(DISTINCT d."id")::INTEGER
    INTO open_document_count
    FROM public."document" d
   WHERE d."tenant_id" = check_tenant
     AND d."client_id" = check_client
     AND d."classification" = 'GWG_EVIDENCE'
     AND d."gwg_destroyed_at" IS NULL
     AND (
       EXISTS (
          SELECT 1 FROM public."gwg_id_document" gid
          WHERE gid."gwg_check_id" = p_check_id
            AND gid."document_id" = d."id"
       )
       OR EXISTS (
          SELECT 1 FROM public."gwg_onboarding_invite" inv
          WHERE inv."gwg_check_id" = p_check_id
            AND inv."id" = d."gwg_onboarding_invite_id"
            AND inv."tenant_id" = check_tenant
            AND inv."client_id" = check_client
       )
     );
  IF open_document_count > 0 THEN
    RAISE EXCEPTION 'Es existieren noch nicht vernichtete GwG-Datei-Belege.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF mandate_ended_at IS NOT NULL THEN
    retention_start := mandate_ended_at;
  ELSE
    IF COALESCE(client_allow_active, FALSE)
       OR client_onboarding_completed_at IS NOT NULL
       OR check_verified_at IS NOT NULL
       OR check_status = 'VERIFIED'
    THEN
      RAISE EXCEPTION 'Ohne Mandatsende ist eine etablierte oder jemals verifizierte Geschäftsbeziehung nicht löschfähig.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF check_status NOT IN ('DRAFT', 'IN_REVIEW', 'REJECTED', 'EXPIRED') THEN
      RAISE EXCEPTION 'Status der nie etablierten GwG-Erstprüfung ist nicht löschfähig.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The finding cannot end before a later child/invite update. This retains
    -- the conservative canonical start while extending eligible statuses only.
    retention_start := GREATEST(
      check_updated_at,
      latest_owner_at,
      latest_id_document_at,
      latest_invite_at
    );
  END IF;

  IF retention_start IS NULL
     OR now_utc < app.retention_until_from_utc(retention_start, 5)
  THEN
    RAISE EXCEPTION 'Reguläre fünfjährige GwG-Aufbewahrungsfrist ist noch nicht abgelaufen.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.gwg_destroy_check_id', p_check_id::TEXT, TRUE);

  UPDATE public."gwg_onboarding_invite"
     SET "invite_email" = ('vernichtet+' || "id"::TEXT || '@taxtronik.local')::public.citext,
         "invite_name" = 'VERNICHTET',
         "token_hash" = 'vernichtet-' || "id"::TEXT,
         "expires_at" = LEAST("expires_at", now_utc),
         "status" = 'EXPIRED',
         "submitted_ip" = NULL,
         "submitted_ua" = NULL,
         "uploaded_document_ids" = '[]'::JSONB,
         "updated_at" = now_utc
   WHERE "gwg_check_id" = p_check_id
     AND "tenant_id" = check_tenant
     AND "client_id" = check_client;

  DELETE FROM public."gwg_beneficial_owner"
   WHERE "gwg_check_id" = p_check_id;

  UPDATE public."gwg_id_document"
     SET "owner_name" = 'VERNICHTET',
         "number" = NULL,
         "issued_by" = NULL,
         "issue_date" = NULL,
         "expiry_date" = NULL,
         "notes" = NULL,
         "document_id" = NULL
   WHERE "gwg_check_id" = p_check_id;

  destroyed_at_utc := CURRENT_TIMESTAMP;
  UPDATE public."gwg_check"
     SET "risk_answers" = NULL,
         "risk_breakdown" = NULL,
         "notes" = NULL,
         "rejected_reason" = NULL,
         "legal_form" = NULL,
         "register_number" = NULL,
         "register_authority" = NULL,
         "no_register_entry" = FALSE,
         "representative_names" = ARRAY[]::TEXT[],
         "ownership_structure_notes" = NULL,
         "destroyed_at" = now_utc,
         "updated_at" = now_utc
   WHERE "id" = p_check_id;

  PERFORM set_config('app.gwg_destroy_check_id', '', TRUE);

  RETURN jsonb_build_object(
    'clientId', check_client,
    'status', check_status,
    'retentionStartedAt', retention_start,
    'destroyedAt', destroyed_at_utc,
    'beneficialOwners', owner_count,
    'idDocuments', id_document_count,
    'invitations', invite_count
  );
EXCEPTION
  WHEN lock_not_available THEN
    RAISE EXCEPTION 'GwG-Prüfung wird parallel bearbeitet; Vorgang erneut starten.'
      USING ERRCODE = 'serialization_failure';
END;
$function$;

-- Nachholen der Steuerfrist für Belege mit früherer oder aktueller Bindung.
-- NULL hält den Claim gesperrt. Vorgemerkte Belege prüft der Claim vor der
-- Vernichtung erneut. Ein bereits höheres Ende bleibt vollständig erhalten.
UPDATE public.document d
   SET retention_until = app.tcms_gwg_evidence_tax_retention_until(d.created_at)
 WHERE d.classification = 'GWG_EVIDENCE'
   AND d.gwg_destruction_requested_at IS NULL
   AND d.gwg_destroyed_at IS NULL
   AND d.retention_until < app.tcms_gwg_evidence_tax_retention_until(d.created_at)
   AND EXISTS (SELECT 1 FROM public.tcms_document_reference r
                WHERE r.document_id = d.id AND r.tenant_id = d.tenant_id);

COMMIT;
