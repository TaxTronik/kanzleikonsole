// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  assertRestoreRolesPresent,
  assertRestoreTargetSecurity,
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
      const probe = probeReturning(OWNER_OK, rows);
      await expect(
        assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
      ).rejects.toThrow('bereits angewendet und nicht zurückgerollt');
      expect(probe.queryRaw).toHaveBeenCalledTimes(2);
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
    const probe = probeReturning(OWNER_OK, [{ aclState: Array(17).fill('true').join('|') }]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('does not accept the former 22-invariant evidence without the anchor and checkpoint write locks', async () => {
    const probe = probeReturning(OWNER_OK, [{ aclState: Array(22).fill('true').join('|') }]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('accepts exactly 30 satisfied invariants with a safe owner role and a non-empty RLS inventory', async () => {
    const probe = probeReturning(OWNER_OK, ALL_30, [{ checked: 3, violations: 0 }]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', probe.factory),
    ).resolves.toBeUndefined();
    expect(probe.queryRaw).toHaveBeenCalledTimes(3);
    const ownerSql = (probe.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(ownerSql).toContain("r.rolname = 'taxtronik_owner'");
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
