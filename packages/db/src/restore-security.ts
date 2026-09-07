// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import type { PrismaClient } from './prisma-client';

type SecurityProbe = Pick<InstanceType<typeof PrismaClient>, '$queryRaw' | '$disconnect'>;

/** Required after pg_restore, including when the optional data smoke is disabled. */
export async function assertRestoreTargetSecurity(
  targetUrl: string,
  createProbe: (url: string) => SecurityProbe,
): Promise<void> {
  const probe = createProbe(targetUrl);
  try {
    // Same 22 effective privilege invariants as scripts/restore-selftest.sh:
    // the original 17 plus five for the counter and permanent ticket links.
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
    if (rows.length !== 1 || rows[0]?.aclState !== Array(22).fill('true').join('|')) {
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
