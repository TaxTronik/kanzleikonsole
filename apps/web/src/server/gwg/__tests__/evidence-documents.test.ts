import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  findCleanGwgEvidenceDocumentsTx,
  lockCleanGwgEvidenceDocumentsTx,
} from '../evidence-documents';

function sqlText(call: unknown[]): string {
  return (call[0] as { sql: string }).sql;
}

describe('GwG-Evidence-Dateizugriff', () => {
  it('sucht über die gesamte Akte und bewertet ausschließlich die neueste CLEAN-Version', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw } as unknown as TxClient;

    await findCleanGwgEvidenceDocumentsTx(tx, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      query: 'Perso_100%',
      excludeLinkedCheckId: '33333333-3333-4333-8333-333333333333',
      limit: 51,
    });

    const sql = sqlText(queryRaw.mock.calls[0]!);
    expect(sql).toContain('ORDER BY dv."version_no" DESC');
    expect(sql).toContain('latest."scan_status" = \'CLEAN\'');
    expect(sql).toContain('latest."scan_completed_at" IS NOT NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('gid."gwg_check_id"');
    expect(sql).toContain('d."title" ILIKE');
    expect(sql).toContain('LIMIT ?');
    expect((queryRaw.mock.calls[0]![0] as { values: unknown[] }).values).toContain(
      '%Perso\\_100\\%%',
    );
  });

  it('sperrt alle Document-Zeilen und prüft Verfügbarkeit plus neueste Scan-Version atomar', async () => {
    const rows = [
      { id: '44444444-4444-4444-8444-444444444444' },
      { id: '55555555-5555-4555-8555-555555555555' },
    ];
    const queryRaw = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
    const tx = { $queryRaw: queryRaw } as unknown as TxClient;

    await expect(
      lockCleanGwgEvidenceDocumentsTx(tx, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        clientId: '22222222-2222-4222-8222-222222222222',
        documentIds: [
          '55555555-5555-4555-8555-555555555555',
          '44444444-4444-4444-8444-444444444444',
        ],
      }),
    ).resolves.toBe(true);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const lockSql = sqlText(queryRaw.mock.calls[0]!);
    expect(lockSql).not.toContain('document_version');
    expect(lockSql).toContain('d."deleted_at" IS NULL');
    expect(lockSql).toContain('d."gwg_destruction_requested_at" IS NULL');
    expect(lockSql).toContain('d."gwg_destroyed_at" IS NULL');
    expect(lockSql).toContain('FOR SHARE OF d');
    const versionSql = sqlText(queryRaw.mock.calls[1]!);
    expect(versionSql).toContain('ORDER BY dv."version_no" DESC');
    expect(versionSql).toContain('latest."scan_status" = \'CLEAN\'');
    expect(versionSql).toContain('latest."scan_completed_at" IS NOT NULL');
  });
});
