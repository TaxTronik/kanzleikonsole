// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import type { PrismaClient } from './prisma-client';

type SecurityProbe = Pick<InstanceType<typeof PrismaClient>, '$queryRaw' | '$disconnect'>;
type RoleSettingsWriter = Pick<
  InstanceType<typeof PrismaClient>,
  '$queryRaw' | '$executeRawUnsafe' | '$disconnect'
>;

export interface CanonicalRoleSetting {
  /** Rolle, für die die Einstellung in der Ziel-Datenbank gilt. */
  readonly role: (typeof ROLE_SETTING_ROLES)[number];
  /** Name des PostgreSQL-Parameters. */
  readonly name: string;
  /** Wert exakt wie in der Migration (pg_db_role_setting speichert den Text). */
  readonly value: string;
  /** Migration, die die Einstellung setzt (Prüfung in role-settings.test.ts). */
  readonly migration: string;
}

/**
 * Rollen der Dienste, deren datenbankbezogene Einstellungen (pg_db_role_setting
 * mit setdatabase = Ziel-DB) das Restore-Gate vollständig kennt: Für sie muss
 * die Ziel-Datenbank genau die kanonischen Einstellungen tragen, nicht mehr und
 * nicht weniger. Die Owner-Rolle hat bewusst keine (Wartungsjobs dürfen warten,
 * Migration 20261007140000).
 */
export const ROLE_SETTING_ROLES = ['taxtronik_app', 'taxtronik_owner'] as const;

/**
 * Welle 15 (Hinweis aus Welle 14): einzige Quelle der kanonischen
 * datenbankbezogenen Rolleneinstellungen. `ALTER ROLE … IN DATABASE … SET`
 * schreibt nach pg_db_role_setting; das gehört zum Cluster, nicht zum pg_dump
 * einer Datenbank. Nach einem Restore in eine neu angelegte Datenbank oder
 * einen neuen Cluster fehlen die Einstellungen deshalb, obwohl das
 * Migrationsledger die Migration als angewendet führt. Die Restore-CLI setzt sie
 * aus dieser Liste vor pg_restore, das Restore-Gate verlangt sie danach.
 * `role-settings.test.ts` prüft die Liste gegen alle Migrationen (jedes
 * `ALTER ROLE … SET` muss hier stehen) und gegen eine frisch migrierte
 * Datenbank.
 */
export const CANONICAL_ROLE_SETTINGS: readonly CanonicalRoleSetting[] = [
  {
    role: 'taxtronik_app',
    name: 'lock_timeout',
    value: '5s',
    migration: '20261007140000_app_role_lock_timeout',
  },
];

/** Darstellung wie in pg_db_role_setting.setconfig, mit vorangestellter Rolle. */
function roleSettingEntry(setting: Pick<CanonicalRoleSetting, 'role' | 'name' | 'value'>): string {
  return `${setting.role} ${setting.name}=${setting.value}`;
}

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SETTING_VALUE = /^[A-Za-z0-9_.]+$/;

/**
 * Statisches ALTER ROLE für eine kanonische Einstellung. Rolle, Name und Wert
 * stammen ausschließlich aus CANONICAL_ROLE_SETTINGS und werden zusätzlich
 * geprüft; den Datenbanknamen quotet PostgreSQL selbst (format %I).
 */
export function alterRoleSettingStatement(setting: CanonicalRoleSetting): string {
  if (
    !SQL_IDENTIFIER.test(setting.role) ||
    !SQL_IDENTIFIER.test(setting.name) ||
    !SETTING_VALUE.test(setting.value)
  ) {
    throw new Error(`Ungültige kanonische Rolleneinstellung: ${roleSettingEntry(setting)}`);
  }
  return (
    'DO $taxtronik_role_setting$ BEGIN EXECUTE pg_catalog.format(' +
    `'ALTER ROLE %I IN DATABASE %I SET %I = %L', '${setting.role}', ` +
    `pg_catalog.current_database(), '${setting.name}', '${setting.value}'); ` +
    'END $taxtronik_role_setting$'
  );
}

/** Rolleneinstellungen der Dienstrollen in der verbundenen Datenbank, sortiert. */
async function readServiceRoleSettings(probe: Pick<SecurityProbe, '$queryRaw'>): Promise<string[]> {
  const rows = await probe.$queryRaw<Array<{ role: string; setting: string }>>`
SELECT r.rolname AS "role", cfg AS "setting"
  FROM pg_catalog.pg_db_role_setting s
  JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS cfg
 WHERE s.setdatabase = (
   SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()
 );
  `;
  if (!Array.isArray(rows)) {
    throw new Error('Rolleneinstellungen der Ziel-Datenbank nicht lesbar.');
  }
  const managed = new Set<string>(ROLE_SETTING_ROLES);
  return rows
    .filter((row) => managed.has(row.role))
    .map((row) => `${row.role} ${row.setting}`)
    .sort();
}

/** Abweichung vom kanonischen Satz als Text; null, wenn genau kanonisch. */
function roleSettingsDeviation(actual: readonly string[]): string | null {
  const expected = CANONICAL_ROLE_SETTINGS.map(roleSettingEntry);
  const missing = expected.filter((entry) => !actual.includes(entry));
  const unexpected = actual.filter((entry) => !expected.includes(entry));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return [
    missing.length > 0 ? `fehlend: ${missing.join(', ')}` : '',
    unexpected.length > 0 ? `abweichend oder zusätzlich: ${unexpected.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

const ROLE_SETTINGS_REMEDY =
  'Kanonisch (Migrationen): ' +
  CANONICAL_ROLE_SETTINGS.map(roleSettingEntry).join(', ') +
  `; für ${ROLE_SETTING_ROLES.join(' und ')} keine weiteren datenbankbezogenen Einstellungen. ` +
  'Zusätzliche Einstellungen als Superuser mit ' +
  '`ALTER ROLE <rolle> IN DATABASE <db> RESET <parameter>` entfernen.';

/**
 * Welle 15: setzt vor pg_restore die kanonischen Rolleneinstellungen der
 * Ziel-Datenbank (nur fehlende oder abweichende) und verlangt danach genau den
 * kanonischen Satz. Läuft mit der Restore-Verbindung (Migrationsrolle bzw.
 * Superuser); eine Rolle ohne Recht auf ALTER ROLE scheitert hier, bevor
 * pg_restore die Ziel-DB verändert. Zusätzliche Einstellungen der Dienstrollen
 * entfernt die CLI nicht still, sondern bricht mit Anleitung ab.
 * Rückgabe: die neu gesetzten Einstellungen (leer, wenn schon kanonisch).
 */
export async function applyCanonicalRoleSettings(
  targetUrl: string,
  createWriter: (url: string) => RoleSettingsWriter,
): Promise<string[]> {
  const writer = createWriter(targetUrl);
  try {
    const before = await readServiceRoleSettings(writer);
    const pending = CANONICAL_ROLE_SETTINGS.filter(
      (setting) => !before.includes(roleSettingEntry(setting)),
    );
    for (const setting of pending) {
      await writer.$executeRawUnsafe(alterRoleSettingStatement(setting));
    }
    const deviation = roleSettingsDeviation(await readServiceRoleSettings(writer));
    if (deviation) throw new Error(deviation);
    return pending.map(roleSettingEntry);
  } catch (error) {
    throw new Error(
      'Rolleneinstellungen der Ziel-Datenbank konnten nicht kanonisch gesetzt werden: ' +
        (error instanceof Error ? error.message : 'Prüfung nicht möglich.') +
        ' Abbruch vor pg_restore: Daten und Rechte der Ziel-DB sind unverändert ' +
        '(höchstens bereits kanonisch gesetzte Rolleneinstellungen). Restore mit der ' +
        'Migrationsrolle bzw. als Superuser ausführen. ' +
        ROLE_SETTINGS_REMEDY,
      { cause: error },
    );
  } finally {
    await writer.$disconnect();
  }
}

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
    // Welle 15: pg_db_role_setting gehört nicht zum Dump. Fehlt etwa das
    // lock_timeout der App-Rolle (F-06), warten Requests wieder unbegrenzt auf
    // Sperren; deshalb fail-closed wie fehlende Grants. Vor den 32 Invarianten,
    // damit die Prüfung auch auf PostgreSQL 16 (ohne MAINTAIN) greift.
    const deviation = roleSettingsDeviation(await readServiceRoleSettings(probe));
    if (deviation) {
      throw new Error(
        `Rolleneinstellungen der Ziel-Datenbank weichen ab (${deviation}). ` + ROLE_SETTINGS_REMEDY,
      );
    }
    // Same 32 effective privilege invariants as scripts/restore-selftest.sh:
    // the original 17, five for the counter and permanent ticket links, seven
    // for the append-only rolling anchors (audit_anchor) and the owner-only
    // verification checkpoints (audit_verify_checkpoint), one for the
    // owner-only anchor lease (audit_anchor_lease) and two for the owner-only
    // tax-cms delivery tables of the worker (tcms_systemakteur,
    // tcms_nachricht_zustellung; TCMS stage 4, MAIL-OUTBOX-001).
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
  (NOT has_table_privilege('taxtronik_app', 'public.tcms_systemakteur',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))::text,
  (NOT has_table_privilege('taxtronik_app', 'public.tcms_nachricht_zustellung',
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
    if (rows.length !== 1 || rows[0]?.aclState !== Array(32).fill('true').join('|')) {
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
