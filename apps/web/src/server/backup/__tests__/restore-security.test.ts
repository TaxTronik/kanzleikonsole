// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCanonicalRoleSettings,
  assertRestoreRolesPresent,
  assertRestoreTargetSecurity,
  CANONICAL_ROLE_SETTINGS,
} from '@taxtronik/db/restore-security';

const ACL_SELECT = "SELECT concat_ws('|',";

function repoFile(path: string): string {
  return readFileSync(new URL(`../../../../../../${path}`, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
}

/** Top-level invariants of an ACL probe (each ends in ::text), whitespace-normalised. */
function aclInvariants(source: string, end: string): string[] {
  const start = source.indexOf(ACL_SELECT);
  const stop = source.indexOf(end, start);
  if (start < 0 || stop < 0) throw new Error('ACL probe not found');
  return source
    .slice(start + ACL_SELECT.length, stop)
    .split('::text')
    .map((part) => part.replace(/^\s*,/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** B6: Ergebnis der Owner-Rollen-Probe eines sicheren Ziels (läuft zuerst). */
const OWNER_OK = [{ roleSafe: true, grantsPresent: true, writeLocks: true }];
/** Welle 15: pg_db_role_setting der Ziel-DB mit genau den kanonischen Einstellungen. */
const ROLE_SETTINGS_OK = [{ role: 'taxtronik_app', setting: 'lock_timeout=5s' }];
const ALL_30 = [{ aclState: Array(30).fill('true').join('|') }];
const PRE_S01_PROCEDURE =
  'Dumps von vor Migration 20261006160000 (S-01) mit dem passenden alten Release ' +
  'wiederherstellen und anschließend per ./taxtronik update anheben.';

function probeReturning(...results: unknown[]) {
  const queryRaw = vi.fn();
  for (const result of results) queryRaw.mockResolvedValueOnce(result);
  const disconnect = vi.fn().mockResolvedValue(undefined);
  return {
    queryRaw,
    disconnect,
    factory: () => ({ $queryRaw: queryRaw, $disconnect: disconnect }),
  };
}

const AUDIT_WRITE_LOCKS = [
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'UPDATE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'DELETE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_anchor', 'TRUNCATE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'INSERT'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'UPDATE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'DELETE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_verify_checkpoint', 'TRUNCATE'))",
  "(NOT has_table_privilege('taxtronik_app', 'public.audit_anchor_lease', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))",
];

describe('Restore security probe failures', () => {
  it.each([{ rows: [] }, { rows: [{ aclState: null }] }, { rows: [{ aclState: 'true' }] }])(
    'rejects incomplete privilege evidence without announcing rollback: %j',
    async ({ rows }) => {
      const probe = probeReturning(OWNER_OK, ROLE_SETTINGS_OK, rows);
      await expect(
        assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
      ).rejects.toThrow('bereits angewendet und nicht zurückgerollt');
      expect(probe.queryRaw).toHaveBeenCalledTimes(3);
      expect(probe.disconnect).toHaveBeenCalledOnce();
    },
  );

  it('does not announce success when PostgreSQL cannot verify the restored state', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
        $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')),
        $disconnect: disconnect,
      })),
    ).rejects.toThrow('Dienste nicht starten');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not accept the former 17-invariant evidence without the ticket protections', async () => {
    const probe = probeReturning(OWNER_OK, ROLE_SETTINGS_OK, [
      { aclState: Array(17).fill('true').join('|') },
    ]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('does not accept the former 22-invariant evidence without the anchor and checkpoint write locks', async () => {
    const probe = probeReturning(OWNER_OK, ROLE_SETTINGS_OK, [
      { aclState: Array(22).fill('true').join('|') },
    ]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('accepts exactly 30 satisfied invariants with a safe owner role and a non-empty RLS inventory', async () => {
    const probe = probeReturning(OWNER_OK, ROLE_SETTINGS_OK, ALL_30, [
      { checked: 3, violations: 0 },
    ]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).resolves.toBeUndefined();
    expect(probe.queryRaw).toHaveBeenCalledTimes(4);
    const ownerSql = (probe.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(ownerSql).toContain("r.rolname = 'taxtronik_owner'");
    const settingsSql = (probe.queryRaw.mock.calls[1]?.[0] as TemplateStringsArray).join(' ');
    expect(settingsSql).toContain('pg_catalog.pg_db_role_setting');
    expect(settingsSql).toContain('pg_catalog.current_database()');
  });

  // Welle 15: Rolleneinstellungen liegen nicht im Dump; das Gate verlangt genau
  // den kanonischen Satz für taxtronik_app und taxtronik_owner.
  it.each([
    [[], /fehlend: taxtronik_app lock_timeout=5s/],
    [
      [{ role: 'taxtronik_app', setting: 'lock_timeout=10s' }],
      /fehlend: taxtronik_app lock_timeout=5s; abweichend oder zusätzlich: taxtronik_app lock_timeout=10s/,
    ],
    [
      [...ROLE_SETTINGS_OK, { role: 'taxtronik_owner', setting: 'lock_timeout=5s' }],
      /abweichend oder zusätzlich: taxtronik_owner lock_timeout=5s/,
    ],
  ])('rejects missing or deviating role settings: %j', async (settingRows, message) => {
    const probe = probeReturning(OWNER_OK, settingRows, ALL_30, [{ checked: 3, violations: 0 }]);
    const failure = assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory);
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toThrow('Dienste nicht starten');
    expect(probe.queryRaw).toHaveBeenCalledTimes(2);
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it('ignores per-database settings of roles outside the service roles', async () => {
    const probe = probeReturning(
      OWNER_OK,
      [...ROLE_SETTINGS_OK, { role: 'taxtronik', setting: 'work_mem=64MB' }],
      ALL_30,
      [{ checked: 3, violations: 0 }],
    );
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).resolves.toBeUndefined();
  });

  // B6 (S-01): die Owner-Rolle der Container wird vor den 30 Invarianten geprüft.
  it.each([
    [[], /Owner-Rolle taxtronik_owner fehlt \(S-01\)/],
    [[{ roleSafe: false, grantsPresent: true, writeLocks: true }], /verletzt S-01/],
    [[{ roleSafe: null, grantsPresent: true, writeLocks: true }], /verletzt S-01/],
    [
      [{ roleSafe: true, grantsPresent: false, writeLocks: true }],
      /ohne die Grants der Migration 20261006160000/,
    ],
    [[{ roleSafe: true, grantsPresent: true, writeLocks: false }], /besitzt unzulässige Rechte/],
    [[OWNER_OK[0], OWNER_OK[0]], /verletzt S-01/],
  ])('rejects an unsafe or missing owner role: %j', async (ownerRows, message) => {
    const probe = probeReturning(ownerRows, ALL_30, [{ checked: 3, violations: 0 }]);
    const failure = assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory);
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toThrow('Dienste nicht starten');
    expect(probe.queryRaw).toHaveBeenCalledOnce();
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it('names the restore procedure for dumps from before the owner role migration', async () => {
    const probe = probeReturning([{ roleSafe: true, grantsPresent: false, writeLocks: true }]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow(PRE_S01_PROCEDURE);
  });
});

describe('Restore roles before pg_restore (B6)', () => {
  const SAFE = { appPresent: true, appSafe: true, ownerPresent: true, ownerSafe: true };

  it('accepts safe app and owner roles', async () => {
    const probe = probeReturning([SAFE]);
    await expect(
      assertRestoreRolesPresent('postgresql://synthetic/test', probe.factory),
    ).resolves.toBeUndefined();
    const sql = (probe.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(sql).toContain("r.rolname = 'taxtronik_owner'");
    expect(sql).toMatch(/AND r\.rolbypassrls/);
    expect(sql).toContain('pg_catalog.pg_auth_members');
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    [[], /taxtronik_app existiert nicht oder besitzt/],
    [[{ ...SAFE, appPresent: false }], /taxtronik_app existiert nicht oder besitzt/],
    [[{ ...SAFE, appSafe: false }], /taxtronik_app existiert nicht oder besitzt/],
    [
      [{ ...SAFE, ownerPresent: false, ownerSafe: false }],
      /taxtronik_owner \(S-01\) existiert nicht/,
    ],
    [[{ ...SAFE, ownerSafe: false }], /taxtronik_owner \(S-01\) besitzt unzulässige/],
    [[{ ...SAFE, ownerSafe: null }], /taxtronik_owner \(S-01\) besitzt unzulässige/],
    [[SAFE, SAFE], /taxtronik_app existiert nicht oder besitzt/],
  ])('stops before pg_restore: %j', async (rows, message) => {
    const probe = probeReturning(rows);
    await expect(
      assertRestoreRolesPresent('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow(message);
    expect(probe.disconnect).toHaveBeenCalledOnce();
  });

  it('names the restore procedure for older dumps when the owner role is missing', async () => {
    const probe = probeReturning([{ ...SAFE, ownerPresent: false, ownerSafe: false }]);
    const failure = assertRestoreRolesPresent('postgresql://synthetic/test', probe.factory);
    await expect(failure).rejects.toThrow(PRE_S01_PROCEDURE);
    await expect(failure).rejects.toThrow('TAXTRONIK_OWNER_PASSWORD');
  });

  it('disconnects when the role probe fails', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await expect(
      assertRestoreRolesPresent('postgresql://synthetic/test', () => ({
        $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')),
        $disconnect: disconnect,
      })),
    ).rejects.toThrow('connection lost');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('runs before pg_restore, the security acceptance after it', () => {
    const cli = repoFile('apps/web/src/server/backup/restore.ts');
    const main = cli.slice(cli.indexOf('async function main()'));
    const roles = main.indexOf('await assertRestoreRolesPresent(');
    const restore = main.indexOf('await runPgRestore(');
    const acceptance = main.indexOf('await assertRestoreTargetSecurity(');
    expect(roles).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(roles);
    expect(acceptance).toBeGreaterThan(restore);
    expect(cli).not.toContain('async function assertRestoreRolesPresent');
  });
});

describe('Restore security invariants of CLI and CI self-test', () => {
  const cli = aclInvariants(repoFile('packages/db/src/restore-security.ts'), '\n) AS "aclState"');
  const selftestSource = repoFile('scripts/restore-selftest.sh');
  const selftest = aclInvariants(selftestSource, '\n);\nSQL');

  it('check the same 30 invariants including the owner-only audit write locks', () => {
    expect(cli).toHaveLength(30);
    expect(selftest).toEqual(cli);
    for (const invariant of AUDIT_WRITE_LOCKS) expect(cli).toContain(invariant);
  });

  it('expects all 30 invariants to hold in the self-test', () => {
    const expected = /^EXPECTED_ACL_STATE="([^"]*)"$/m.exec(selftestSource)?.[1];
    expect(expected?.split('|')).toEqual(Array(30).fill('true'));
  });
});

describe('Canonical role settings before pg_restore (Welle 15)', () => {
  function writer(...reads: unknown[]) {
    const queryRaw = vi.fn();
    for (const result of reads) queryRaw.mockResolvedValueOnce(result);
    const executeRawUnsafe = vi.fn().mockResolvedValue(0);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    return {
      queryRaw,
      executeRawUnsafe,
      disconnect,
      factory: () => ({
        $queryRaw: queryRaw,
        $executeRawUnsafe: executeRawUnsafe,
        $disconnect: disconnect,
      }),
    };
  }

  it('changes nothing when the target already carries the canonical settings', async () => {
    const target = writer(ROLE_SETTINGS_OK, ROLE_SETTINGS_OK);
    await expect(
      applyCanonicalRoleSettings('postgresql://synthetic/test', target.factory),
    ).resolves.toEqual([]);
    expect(target.executeRawUnsafe).not.toHaveBeenCalled();
    expect(target.disconnect).toHaveBeenCalledOnce();
  });

  it('sets missing settings with the static statement and verifies the result', async () => {
    const target = writer([], ROLE_SETTINGS_OK);
    await expect(
      applyCanonicalRoleSettings('postgresql://synthetic/test', target.factory),
    ).resolves.toEqual(['taxtronik_app lock_timeout=5s']);
    expect(target.executeRawUnsafe).toHaveBeenCalledOnce();
    expect(target.executeRawUnsafe.mock.calls[0]?.[0]).toContain(
      "'ALTER ROLE %I IN DATABASE %I SET %I = %L', 'taxtronik_app', " +
        "pg_catalog.current_database(), 'lock_timeout', '5s'",
    );
    expect(target.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('stops before pg_restore when extra settings remain or ALTER ROLE is not permitted', async () => {
    const extra = writer(
      [...ROLE_SETTINGS_OK, { role: 'taxtronik_owner', setting: 'lock_timeout=5s' }],
      [...ROLE_SETTINGS_OK, { role: 'taxtronik_owner', setting: 'lock_timeout=5s' }],
    );
    await expect(
      applyCanonicalRoleSettings('postgresql://synthetic/test', extra.factory),
    ).rejects.toThrow(/zusätzlich: taxtronik_owner lock_timeout=5s.*Abbruch vor pg_restore/s);
    expect(extra.executeRawUnsafe).not.toHaveBeenCalled();
    expect(extra.disconnect).toHaveBeenCalledOnce();

    const denied = writer([]);
    denied.executeRawUnsafe.mockRejectedValueOnce(new Error('permission denied to alter role'));
    await expect(
      applyCanonicalRoleSettings('postgresql://synthetic/test', denied.factory),
    ).rejects.toThrow(/permission denied to alter role.*Abbruch vor pg_restore/s);
    expect(denied.disconnect).toHaveBeenCalledOnce();
  });

  it('runs after the overwrite check and before pg_restore in the CLI', () => {
    const cli = repoFile('apps/web/src/server/backup/restore.ts');
    const main = cli.slice(cli.indexOf('async function main()'));
    const empty = main.indexOf('await targetIsEmpty(');
    const settings = main.indexOf('await applyCanonicalRoleSettings(');
    const restore = main.indexOf('await runPgRestore(');
    const acceptance = main.indexOf('await assertRestoreTargetSecurity(');
    expect(settings).toBeGreaterThan(empty);
    expect(restore).toBeGreaterThan(settings);
    expect(acceptance).toBeGreaterThan(restore);
  });

  it('expects the canonical app-role setting in the CI self-test probe', () => {
    const selftest = repoFile('scripts/restore-selftest.sh');
    const expected = /^EXPECTED_APP_PROBE="([^"]*)"$/m.exec(selftest)?.[1];
    const appSettings = CANONICAL_ROLE_SETTINGS.filter((s) => s.role === 'taxtronik_app');
    expect(appSettings.map((s) => s.name)).toEqual(['lock_timeout']);
    expect(expected).toBe(`taxtronik_app|NULL|0|${appSettings[0]!.value}`);
    expect(selftest).toContain("current_setting('lock_timeout')");
  });
});
