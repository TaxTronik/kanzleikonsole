// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import type { PrismaClient } from './prisma-client';

type SecurityProbe = Pick<InstanceType<typeof PrismaClient>, '$queryRaw' | '$disconnect'>;

/**
 * B6 (S-01): Dumps von vor der Migration 20261006160000_owner_role_least_privilege
 * enthalten weder Grants noch Default-Privilegien der Owner-Rolle taxtronik_owner.
 * Wie andere Altdumps werden sie mit dem passenden alten Release wiederhergestellt
 * und anschließend per Update (Migration) angehoben.
 */
export const PRE_OWNER_ROLE_DUMP_PROCEDURE =
  'Dumps von vor Migration 20261006160000 (S-01) mit dem passenden alten Release ' +
  'wiederherstellen und anschließend per ./taxtronik update anheben.';

/**
 * Vor pg_restore: ACLs/REVOKEs sind Teil des Backups. PostgreSQL kann sie nur
 * einspielen, wenn die referenzierten Rollen clusterweit bereits existieren. Der
 * Operator-Wrapper synchronisiert sie aus der .env; direkte CLI-Aufrufe erhalten
 * hier einen klaren Fehler statt eines halben Restore-Versuchs. Die Owner-Rolle
 * muss die Attribute aus 20261006160000 tragen (NOSUPERUSER NOCREATEDB
 * NOCREATEROLE NOREPLICATION BYPASSRLS) und darf keiner Rolle angehören.
 */
export async function assertRestoreRolesPresent(
  targetUrl: string,
  createProbe: (url: string) => SecurityProbe,
): Promise<void> {
  const probe = createProbe(targetUrl);
  try {
    const rows = await probe.$queryRaw<
      Array<{ appPresent: boolean; appSafe: boolean; ownerPresent: boolean; ownerSafe: boolean }>
    >`
SELECT
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'taxtronik_app'
  ) AS "appPresent",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'taxtronik_app'
       AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
       AND NOT rolreplication AND NOT rolbypassrls
  ) AS "appSafe",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'taxtronik_owner'
  ) AS "ownerPresent",
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname = 'taxtronik_owner'
       AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
       AND NOT r.rolreplication AND r.rolbypassrls
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid
       )
  ) AS "ownerSafe";
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row?.appPresent !== true || row.appSafe !== true) {
      throw new Error(
        'Restore-Voraussetzung fehlt: PostgreSQL-Rolle taxtronik_app existiert nicht ' +
          'oder besitzt unzulässige Clusterrechte. Zuerst ./taxtronik restore verwenden ' +
          'oder die Rolle aus der .env sicher bootstrapen.',
      );
    }
    if (row.ownerPresent !== true || row.ownerSafe !== true) {
      throw new Error(
        'Restore-Voraussetzung fehlt: PostgreSQL-Rolle taxtronik_owner (S-01) ' +
          (row.ownerPresent === true
            ? 'besitzt unzulässige Clusterrechte oder Rollenmitgliedschaften'
            : 'existiert nicht') +
          ' (erwartet: NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS, ' +
          'keine Mitgliedschaften). Zuerst ./taxtronik restore verwenden, das die Rolle ' +
          'aus TAXTRONIK_OWNER_PASSWORD der .env anlegt, oder die Rolle sicher bootstrapen. ' +
          PRE_OWNER_ROLE_DUMP_PROCEDURE,
      );
    }
  } finally {
    await probe.$disconnect();
  }
}

/** Required after pg_restore, including when the optional data smoke is disabled. */
export async function assertRestoreTargetSecurity(
  targetUrl: string,
  createProbe: (url: string) => SecurityProbe,
): Promise<void> {
  const probe = createProbe(targetUrl);
  try {
    // B6: zuerst die Owner-Rolle der Container (S-01). Ein Altdump ohne ihre
    // Grants erhält so die Anweisung zum Wiederherstellen mit dem alten Release.
    await assertOwnerRoleRestored(probe);
    // Same 30 effective privilege invariants as scripts/restore-selftest.sh:
    // the original 17, five for the counter and permanent ticket links, seven
    // for the append-only rolling anchors (audit_anchor) and the owner-only
    // verification checkpoints (audit_verify_checkpoint), and one for the
    // owner-only anchor lease (audit_anchor_lease).
    // Target default privileges may re-grant permissions while pg_restore
    // recreates tables; a successful process exit does not prove safe ACLs.
    const rows = await probe.$queryRaw<Array<{ aclState: string }>>`
SELECT concat_ws('|',
  (EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'taxtronik_app'
       AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
       AND NOT rolreplication AND NOT rolbypassrls
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles elevated
          WHERE pg_catalog.pg_has_role('taxtronik_app', elevated.oid, 'SET')
            AND (elevated.rolsuper OR elevated.rolcreatedb OR elevated.rolcreaterole
              OR elevated.rolreplication OR elevated.rolbypassrls
              OR EXISTS (
                SELECT 1 FROM pg_catalog.pg_class owned
                JOIN pg_catalog.pg_namespace ns ON ns.oid = owned.relnamespace
                WHERE owned.relowner = elevated.oid AND ns.nspname = 'public'
                  AND owned.relkind IN ('r', 'p')
              ))
       )
  ))::text,
  has_schema_privilege('taxtronik_app', 'app', 'USAGE')::text,
  has_function_privilege('taxtronik_app', 'app.current_tenant_id()', 'EXECUTE')::text,
  has_function_privilege('taxtronik_app', 'app.destroy_gwg_check(uuid)', 'EXECUTE')::text,
  has_function_privilege('taxtronik_app', 'app.destroy_gwg_document_versions(uuid)', 'EXECUTE')::text,
  has_table_privilege('taxtronik_app', 'public.audit_log', 'SELECT')::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_log', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_log', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_log', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_seal', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_seal', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_seal', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_archive', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_archive', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_archive', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'INSERT'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'UPDATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'DELETE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'TRUNCATE'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.audit_anchor_lease',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.document_version', 'DELETE'))::text,
  (NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) acl
     WHERE p.oid IN (
       'app.destroy_gwg_check(uuid)'::regprocedure,
       'app.assert_gwg_document_destruction_due(uuid)'::regprocedure,
       'app.destroy_gwg_document_versions(uuid)'::regprocedure,
       'app.allocate_reminder_ticket_number()'::regprocedure,
       'app.guard_reminder_ticket_identity()'::regprocedure
     )
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.client_reminder_counter',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  has_table_privilege('taxtronik_app', 'public.client_reminder_reference', 'SELECT')::text,
  has_table_privilege('taxtronik_app', 'public.client_reminder_reference', 'INSERT')::text,
  (NOT has_table_privilege('taxtronik_app', 'public.client_reminder_reference',
    'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  (NOT has_function_privilege('taxtronik_app', 'app.allocate_reminder_ticket_number()', 'EXECUTE')
    AND NOT has_function_privilege('taxtronik_app', 'app.guard_reminder_ticket_identity()', 'EXECUTE'))::text
) AS "aclState";
    `;
    if (rows.length !== 1 || rows[0]?.aclState !== Array(30).fill('true').join('|')) {
      throw new Error('Rollen-/Grant-/REVOKE-Invarianten verletzt.');
    }
    // Match verify-rls.ts's documented global exceptions. Include partitioned
    // tables so introducing a partitioned tenant root cannot bypass this gate.
    const rls = await probe.$queryRaw<Array<{ checked: number; violations: number }>>`
SELECT count(*)::int AS "checked",
  count(*) FILTER (WHERE NOT c.relrowsecurity OR NOT c.relforcerowsecurity
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid))::int AS "violations"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
  AND c.relname NOT IN ('_prisma_migrations', 'tax_news_item', 'fido_mds_trust_state');
    `;
    if (
      rls.length !== 1 ||
      !Number.isInteger(rls[0]?.checked) ||
      rls[0]!.checked <= 0 ||
      rls[0]?.violations !== 0
    ) {
      throw new Error('ENABLE/FORCE-RLS oder Policies fehlen.');
    }
  } catch (error) {
    throw new Error(
      'Restore-Sicherheitsabnahme fehlgeschlagen: ' +
        (error instanceof Error ? error.message : 'Prüfung nicht möglich.') +
        ' Der Restore wurde bereits angewendet und nicht zurückgerollt. ' +
        'Dienste nicht starten; Zielrechte/RLS prüfen und erneut sicher wiederherstellen.',
      { cause: error },
    );
  } finally {
    await probe.$disconnect();
  }
}

/**
 * B6 (S-01): effektiver Zustand der Owner-Rolle der Container nach pg_restore.
 * Attribute wie vor dem Restore, kein Objektbesitz und kein CREATE; die Grants
 * der Migration 20261006160000 stammen aus dem Dump (fehlen sie, ist es ein
 * Altdump). Wie bei der App-Rolle gelten die Audit-Schreibsperren und das Verbot
 * von TRUNCATE/REFERENCES/TRIGGER/MAINTAIN auch dann, wenn Default-Privilegien
 * des Ziels beim Neuanlegen der Tabellen Rechte vergeben haben.
 */
async function assertOwnerRoleRestored(probe: SecurityProbe): Promise<void> {
  const rows = await probe.$queryRaw<
    Array<{ roleSafe: boolean; grantsPresent: boolean; writeLocks: boolean }>
  >`
WITH owner_role AS (
  SELECT r.oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = 'taxtronik_owner'
), public_tables AS (
  SELECT c.oid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
)
SELECT
  (NOT o.rolsuper AND NOT o.rolcreatedb AND NOT o.rolcreaterole
    AND NOT o.rolreplication AND o.rolbypassrls
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = o.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = o.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = o.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspowner = o.oid)
    AND NOT pg_catalog.has_database_privilege(o.oid, pg_catalog.current_database(), 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(o.oid, 'public', 'CREATE')
    AND NOT pg_catalog.has_schema_privilege(o.oid, 'app', 'CREATE')) AS "roleSafe",
  (pg_catalog.has_schema_privilege(o.oid, 'public', 'USAGE')
    AND pg_catalog.has_schema_privilege(o.oid, 'app', 'USAGE')
    AND pg_catalog.has_table_privilege(o.oid, 'public.tenant', 'INSERT')
    AND pg_catalog.has_table_privilege(o.oid, 'public.tenant', 'UPDATE')
    AND pg_catalog.has_table_privilege(o.oid, 'public.tenant', 'DELETE')
    AND NOT EXISTS (
      SELECT 1 FROM public_tables t
       WHERE NOT pg_catalog.has_table_privilege(o.oid, t.oid, 'SELECT')
    )) AS "grantsPresent",
  (NOT pg_catalog.has_table_privilege(o.oid, 'public.audit_log', 'UPDATE,DELETE,TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(o.oid, 'public.audit_seal', 'UPDATE,DELETE,TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(o.oid, 'public.audit_anchor', 'UPDATE,DELETE,TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(o.oid, 'public.audit_archive', 'DELETE,TRUNCATE')
    AND NOT pg_catalog.has_table_privilege(o.oid, 'public._prisma_migrations',
      'INSERT,UPDATE,DELETE,TRUNCATE')
    AND NOT EXISTS (
      SELECT 1 FROM public_tables t
       WHERE pg_catalog.has_table_privilege(o.oid, t.oid, 'TRUNCATE,REFERENCES,TRIGGER')
          OR CASE WHEN pg_catalog.current_setting('server_version_num')::int >= 170000
                  THEN pg_catalog.has_table_privilege(o.oid, t.oid, 'MAINTAIN')
                  ELSE false END
    )) AS "writeLocks"
FROM owner_role o;
  `;
  if (rows.length === 0) {
    throw new Error('Owner-Rolle taxtronik_owner fehlt (S-01). ' + PRE_OWNER_ROLE_DUMP_PROCEDURE);
  }
  const owner = rows.length === 1 ? rows[0] : undefined;
  if (owner?.roleSafe !== true) {
    throw new Error(
      'Owner-Rolle taxtronik_owner verletzt S-01 (Superuser-/Clusterrechte, ' +
        'Rollenmitgliedschaften, Objektbesitz oder CREATE-Rechte).',
    );
  }
  if (owner.grantsPresent !== true) {
    throw new Error(
      'Owner-Rolle taxtronik_owner ohne die Grants der Migration 20261006160000 (S-01); ' +
        'der Dump stammt vermutlich von vor S-01. ' +
        PRE_OWNER_ROLE_DUMP_PROCEDURE,
    );
  }
  if (owner.writeLocks !== true) {
    throw new Error(
      'Owner-Rolle taxtronik_owner besitzt unzulässige Rechte (Schreibsperren der ' +
        'Audit-Tabellen, Migrationsledger oder TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).',
    );
  }
}
