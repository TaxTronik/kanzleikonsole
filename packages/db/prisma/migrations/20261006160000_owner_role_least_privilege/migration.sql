-- ACCESS-TENANT-RLS-001 / AUDIT-HASH-CHAIN-001 / AUDIT-ARCHIVE-001 /
-- TAX-DEADLINE-AUTOREQUEST-001 / DSGVO-OPERATIONAL-RETENTION-001.
--
-- Rollenmodell aus 20260510000000_init (Punkte 10/11), Doppelschicht der
-- Audit-Tabellen aus 20260510000000_init, 20260701000000_iter50_audit_archive_
-- truncate_trigger und 20260801000800_iter83_rls_hardening, Purge-Freigabe von
-- app.tax_deadline_guard_notification_history aus 20260823201000_tax_
-- professional_control_model.
--
-- Review-Finding S-01. Die Owner-Verbindung (DATABASE_URL) der Container app
-- und worker nutzte bisher `taxtronik`, den Bootstrap-Superuser des
-- Postgres-Images. Codeausfuehrung oder SQL-Injection auf einem Owner-Pfad
-- (Login, n8n-Callbacks, iCal, fast alle Worker-Jobs) bedeutete damit volle
-- Kontrolle ueber den Cluster: COPY ... TO PROGRAM, Rollen anlegen, Audit-
-- Trigger per session_replication_role abschalten.
--
-- Neu ist die Rolle `taxtronik_owner` fuer genau diese Verbindung:
--   - NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION, aber BYPASSRLS. Die
--     RLS-Semantik bleibt unveraendert: Owner-Pfade umgehen RLS wie bisher,
--     taxtronik_app bleibt RLS-gebunden.
--   - Nur DML (SELECT/INSERT/UPDATE/DELETE) auf den Tabellen in public,
--     USAGE/SELECT auf Sequenzen, USAGE auf public und app. Kein TRUNCATE,
--     REFERENCES, TRIGGER; keine Tabelle gehoert ihr, also weder DDL noch
--     ALTER TABLE ... DISABLE TRIGGER.
--   - Hash-Chain-Tabellen wie bei taxtronik_app zweischichtig: kein UPDATE/
--     DELETE auf audit_log, audit_seal, audit_anchor (Statement-Trigger
--     blocken ohnehin), kein DELETE auf audit_archive (UPDATE bleibt fuer den
--     Nachstempel PENDING -> STAMPED_LATE, den der Guard-Trigger begrenzt).
--   - _prisma_migrations nur lesbar (pg_dump des Worker-Backups).
--   - EXECUTE auf genau die Funktionen, die taxtronik_app ausdruecklich
--     ausfuehren darf (z. B. app.settle_storage_intent,
--     app.lock_matching_fido_mds_state). Funktionen ohne PUBLIC-EXECUTE, die
--     nur andere SECURITY-DEFINER-Funktionen oder Trigger aufrufen, bleiben
--     gesperrt.
--   - Default-Privilegien fuer Tabellen/Sequenzen, die die Migrationsrolle
--     kuenftig anlegt. Neue Funktionen mit REVOKE FROM PUBLIC brauchen wie
--     bei taxtronik_app einen ausdruecklichen Grant (Paritaetstest:
--     packages/db/src/__tests__/owner-role-privileges.test.ts).
-- Die Rolle entsteht hier NOLOGIN, falls sie fehlt; LOGIN und Passwort setzt
-- ausschliesslich das Init-Skript bzw. ./taxtronik (sync_postgres_roles_from_
-- env) aus TAXTRONIK_OWNER_PASSWORD. Bestehende Attribute werden bei jedem
-- Lauf fail-closed nachgezogen, LOGIN und Passwort bleiben unberuehrt.
--
-- Der DSGVO-Purge (dsgvo-retention) neutralisierte den technischen
-- Benachrichtigungszustand bisher per set_config + UPDATE als Superuser. Der
-- Trigger app.tax_deadline_guard_notification_history erkennt den Purge aber
-- nur unter der Rolle, der public.tax_deadline gehoert; taxtronik_owner ist
-- das bewusst nicht. app.purge_tax_deadline_request_links fuehrt dieselbe
-- Neutralisierung als SECURITY DEFINER des Tabellen-Owners aus, nur fuer
-- taxtronik_owner ausfuehrbar, tenantgebunden und mit zurueckgesetzter
-- Freigabe. Der Trigger selbst bleibt unveraendert; ein frei gesetztes GUC
-- autorisiert weiterhin weder taxtronik_app noch taxtronik_owner.
BEGIN;

DO $owner_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'taxtronik_owner') THEN
    CREATE ROLE taxtronik_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  ELSE
    ALTER ROLE taxtronik_owner
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END
$owner_role$;

GRANT USAGE ON SCHEMA public TO taxtronik_owner;
GRANT USAGE ON SCHEMA app TO taxtronik_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO taxtronik_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taxtronik_owner;

REVOKE INSERT, UPDATE, DELETE ON public."_prisma_migrations" FROM taxtronik_owner;
REVOKE UPDATE, DELETE ON public."audit_log" FROM taxtronik_owner;
REVOKE UPDATE, DELETE ON public."audit_seal" FROM taxtronik_owner;
REVOKE UPDATE, DELETE ON public."audit_anchor" FROM taxtronik_owner;
REVOKE DELETE ON public."audit_archive" FROM taxtronik_owner;

DO $owner_execute$
DECLARE
  routine regprocedure;
BEGIN
  FOR routine IN
    SELECT p.oid::regprocedure
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('app', 'public')
       AND p.prokind IN ('f', 'p')
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(p.proacl) acl
          WHERE acl.grantee = 'taxtronik_app'::regrole
            AND acl.privilege_type = 'EXECUTE'
       )
     ORDER BY p.oid
  LOOP
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO taxtronik_owner', routine);
  END LOOP;
END
$owner_execute$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taxtronik_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO taxtronik_owner;

CREATE FUNCTION app.purge_tax_deadline_request_links(
  p_tenant_id UUID,
  p_request_ids UUID[],
  p_origin_deadline_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  neutralized INTEGER;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'TAX_DEADLINE_PURGE_TENANT: Tenant ist Pflicht.'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Freigabe fuer den unveraenderten Guard-Trigger: Er prueft zusaetzlich,
  -- dass current_user der Tabellen-Owner ist, was nur innerhalb dieser
  -- SECURITY-DEFINER-Funktion gilt.
  PERFORM pg_catalog.set_config('app.tax_deadline_notification_purge', 'on', true);

  -- Dieselbe Auswahl und derselbe Zielzustand wie bisher im Worker
  -- (dsgvo-retention, TAX-DEADLINE-AUTOREQUEST-001): noch bestehende
  -- Request-Pointer sowie bereits ORPHANED geloeste Ursprungszeilen.
  UPDATE public."tax_deadline" AS deadline
     SET "request_id" = NULL,
         "auto_request_notification_status" = 'NOT_REQUIRED',
         "auto_request_notification_attempt_count" = 0,
         "auto_request_notification_last_attempt_at" = NULL,
         "auto_request_notification_next_attempt_at" = NULL,
         "auto_request_notification_accepted_at" = NULL,
         "auto_request_notification_last_error" = NULL,
         "auto_request_notification_escalated_at" = NULL,
         "updated_at" = pg_catalog.timezone('UTC', pg_catalog.now())
   WHERE deadline."tenant_id" = p_tenant_id
     AND (
       deadline."request_id" = ANY (COALESCE(p_request_ids, ARRAY[]::UUID[]))
       OR (
         deadline."id" = ANY (COALESCE(p_origin_deadline_ids, ARRAY[]::UUID[]))
         AND deadline."request_id" IS NULL
         AND deadline."auto_request_notification_status" = 'ORPHANED'
       )
     );
  GET DIAGNOSTICS neutralized = ROW_COUNT;

  -- set_config(..., true) gilt sonst bis Transaktionsende fort; die Freigabe
  -- endet mit dieser Funktion.
  PERFORM pg_catalog.set_config('app.tax_deadline_notification_purge', '', true);
  RETURN neutralized;
END;
$$;

-- Der Guard-Trigger vergleicht current_user mit dem Owner von tax_deadline.
DO $purge_function_owner$
DECLARE
  deadline_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO deadline_owner
    FROM pg_catalog.pg_class AS class
   WHERE class.oid = 'public.tax_deadline'::regclass;

  IF deadline_owner IS NULL THEN
    RAISE EXCEPTION 'Could not resolve the tax_deadline table owner'
      USING ERRCODE = 'data_exception';
  END IF;

  EXECUTE format(
    'ALTER FUNCTION app.purge_tax_deadline_request_links(UUID, UUID[], UUID[]) OWNER TO %I',
    deadline_owner
  );
END
$purge_function_owner$;

REVOKE ALL ON FUNCTION app.purge_tax_deadline_request_links(UUID, UUID[], UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_tax_deadline_request_links(UUID, UUID[], UUID[])
  TO taxtronik_owner;

COMMENT ON FUNCTION app.purge_tax_deadline_request_links(UUID, UUID[], UUID[]) IS
  'S-01: DSGVO-Purge der Auto-Request-Verknuepfung (dsgvo-retention) unter dem Tabellen-Owner; nur fuer taxtronik_owner ausfuehrbar.';

COMMIT;
