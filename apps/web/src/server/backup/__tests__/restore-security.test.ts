// Fachkatalog: ACCESS-TENANT-RLS-001, AUDIT-HASH-CHAIN-001, REMINDER-TICKET-001.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assertRestoreTargetSecurity } from '@taxtronik/db/restore-security';

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
      const disconnect = vi.fn().mockResolvedValue(undefined);
      await expect(
        assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
          $queryRaw: vi.fn().mockResolvedValue(rows),
          $disconnect: disconnect,
        })),
      ).rejects.toThrow('bereits angewendet und nicht zurückgerollt');
      expect(disconnect).toHaveBeenCalledOnce();
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
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
        $queryRaw: vi.fn().mockResolvedValue([{ aclState: Array(17).fill('true').join('|') }]),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      })),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('does not accept the former 22-invariant evidence without the anchor and checkpoint write locks', async () => {
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
        $queryRaw: vi.fn().mockResolvedValue([{ aclState: Array(22).fill('true').join('|') }]),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      })),
    ).rejects.toThrow('Dienste nicht starten');
  });

  it('accepts exactly 30 satisfied invariants with a non-empty RLS inventory', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ aclState: Array(30).fill('true').join('|') }])
      .mockResolvedValueOnce([{ checked: 3, violations: 0 }]);
    await expect(
      assertRestoreTargetSecurity('postgresql://synthetic/test', () => ({
        $queryRaw: queryRaw,
        $disconnect: vi.fn().mockResolvedValue(undefined),
      })),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(2);
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
