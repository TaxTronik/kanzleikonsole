// Fachkatalog: DSGVO-CONTACT-EXPORT-001
// Welle 15 (Folgepunkt P-11): Download des im Worker erzeugten Pakets — nur das
// am Antrag gebundene Ergebnis, aus der gespeicherten Objektversion, nach
// Größen- und Hash-Prüfung, auditiert.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@taxtronik/storage', () => ({ fetchVerifiedObjectBytes: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import {
  DsgvoExportUnavailableError,
  dsgvoExportFilename,
  loadDsgvoExportDownload,
  type DsgvoExportDownloadDeps,
} from '../export-download';

const SHA = new Uint8Array(32).fill(9);
const CTX = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };
const PREPARED = new Date('2026-10-12T10:00:00Z');

function deps(
  options: { resultSha?: Uint8Array | null; exportSha?: Uint8Array; none?: boolean } = {},
) {
  const tx = {
    dsgvoRequest: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'req-1',
        subjectName: 'Erika Mustermann',
        resultSha256: options.resultSha === undefined ? SHA : options.resultSha,
        resultPreparedAt: PREPARED,
      }),
    },
    dsgvoExport: {
      findFirst: vi.fn().mockResolvedValue(
        options.none
          ? null
          : {
              id: 'exp-1',
              storageBucket: 'general',
              storageKey: 'tenants/tenant-1/none/x.bin',
              storageVersionId: 'v1',
              sha256: options.exportSha ?? SHA,
              sizeBytes: 12n,
              finishedAt: PREPARED,
            },
      ),
    },
  };
  const d: DsgvoExportDownloadDeps = {
    inTenant: vi.fn(async (_ctx, fn) => fn(tx as never)),
    fetchVerified: vi.fn(async () => Buffer.from('{"ok": true}') as never),
    record: vi.fn(async () => ({})),
  };
  return { d, tx };
}

describe('DSGVO-Paket herunterladen (Welle 15)', () => {
  it('liefert die geprüften Bytes der gebundenen Version und auditiert den Download', async () => {
    const { d, tx } = deps();
    const download = await loadDsgvoExportDownload(CTX, 'req-1', d);
    expect(tx.dsgvoExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'req-1', status: 'DONE', objectDeletedAt: null },
      }),
    );
    expect(d.fetchVerified).toHaveBeenCalledWith(
      { bucket: 'general', key: 'tenants/tenant-1/none/x.bin', versionId: 'v1' },
      { sizeBytes: 12n, sha256: SHA },
    );
    expect(d.record).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: 'dsgvo.export.download',
      resourceType: 'dsgvo_request',
      resourceId: 'req-1',
      after: { exportId: 'exp-1', sha256: Buffer.from(SHA).toString('hex') },
    });
    expect(download.filename).toBe('dsgvo-auskunft-Erika-Mustermann-2026-10-12.json');
    expect(download.bytes.toString()).toBe('{"ok": true}');
  });

  it.each([
    ['kein Ergebnis am Antrag', { resultSha: null }],
    ['kein fertiges Paket', { none: true }],
    ['Paket ist nicht das gebundene Ergebnis', { exportSha: new Uint8Array(32).fill(1) }],
  ])('verweigert den Download: %s', async (_label, options) => {
    const { d } = deps(options);
    await expect(loadDsgvoExportDownload(CTX, 'req-1', d)).rejects.toBeInstanceOf(
      DsgvoExportUnavailableError,
    );
    expect(d.fetchVerified).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it('auditiert nichts, wenn die Integritätsprüfung scheitert', async () => {
    const { d } = deps();
    vi.mocked(d.fetchVerified).mockRejectedValueOnce(new Error('HASH_MISMATCH'));
    await expect(loadDsgvoExportDownload(CTX, 'req-1', d)).rejects.toThrow('HASH_MISMATCH');
    expect(d.record).not.toHaveBeenCalled();
  });

  it('benennt die Datei wie der frühere Browser-Download', () => {
    expect(dsgvoExportFilename('Max  von Muster', new Date('2026-01-02T23:00:00Z'))).toBe(
      'dsgvo-auskunft-Max-von-Muster-2026-01-02.json',
    );
  });
});
