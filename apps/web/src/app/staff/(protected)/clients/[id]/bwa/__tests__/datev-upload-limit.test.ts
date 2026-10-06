// Review-Finding F-09: Der DATEV-BWA-Import erhält die XLSX binär als File in
// FormData. Bis exakt zur erlaubten Grenze (20 MB) kommt die Datei an — über
// base64 im Action-Body waren effektiv nur rund 7,5 MB möglich.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  parseDatevBwaXlsx: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/bwa/addison-parser', () => ({
  parseAddisonBwaCsv: vi.fn(),
  parseAddisonBwaCompactCsv: vi.fn(),
}));
vi.mock('@/server/bwa/datev-parser', () => ({ parseDatevBwaXlsx: h.parseDatevBwaXlsx }));
vi.mock('@/server/auth/rbac', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  return {
    assertClientAccessTx: h.assertClientAccessTx,
    toActionError: (error: unknown) => ({
      ok: false,
      error: error instanceof ActionError ? error.message : 'Unerwarteter Fehler.',
    }),
  };
});
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  const { parseFormData } = await vi.importActual<typeof import('@/server/actions/form-data')>(
    '@/server/actions/form-data',
  );
  return {
    ActionError,
    parseFormData,
    staffActionGuard: h.staffActionGuard,
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: (
      await vi.importActual<typeof import('@/server/actions/action-runner')>(
        '@/server/actions/action-runner',
      )
    ).createActionRunner(h.staffActionGuard),
  };
});

import { importDatevXlsxAction } from '../actions';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/upload-limits.mjs';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const MIB = 1024 * 1024;
const LIMIT = MAX_UPLOAD_BYTES_BY_KIND.bwaXlsx;

function xlsxUpload(size: number): FormData {
  const upload = new FormData();
  upload.set(
    'file',
    new File([new Uint8Array(size)], 'mandant_2025_Vorjahresvergleich.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  return upload;
}

describe('importDatevXlsxAction — binärer Upload an der Grenze (F-09)', () => {
  const tx = {
    client: { findUnique: vi.fn() },
    bwaPeriod: { findFirst: vi.fn(), create: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      session: {},
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    });
    h.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    h.assertClientAccessTx.mockResolvedValue(undefined);
    tx.client.findUnique.mockResolvedValue({ id: CLIENT_ID });
    tx.bwaPeriod.findFirst.mockResolvedValue(null);
    tx.bwaPeriod.create.mockResolvedValue({ id: 'period-1' });
    h.parseDatevBwaXlsx.mockResolvedValue({
      periods: [
        {
          type: 'MONTH',
          periodKey: '2025-01',
          fromDate: new Date('2025-01-01'),
          toDate: new Date('2025-01-31'),
          positions: [],
        },
      ],
      warnings: [],
    });
  });

  it.each([
    ['19 MB', 19 * MIB],
    ['genau 20 MB', LIMIT],
  ])('importiert eine XLSX von %s', async (_label, size) => {
    await expect(importDatevXlsxAction({ clientId: CLIENT_ID }, xlsxUpload(size))).resolves.toEqual(
      { ok: true, imported: 1, skipped: 0, warnings: [] },
    );
    const buffer = h.parseDatevBwaXlsx.mock.calls[0]![0] as Buffer;
    expect(buffer.length).toBe(size);
    expect(tx.bwaPeriod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceRef: 'mandant_2025_Vorjahresvergleich.xlsx' }),
    });
  });

  it('lehnt ein Byte über der Grenze vor Zugriffsprüfung und Parser ab', async () => {
    await expect(
      importDatevXlsxAction({ clientId: CLIENT_ID }, xlsxUpload(LIMIT + 1)),
    ).resolves.toEqual({ ok: false, error: 'Datei zu groß (max. 20 MB).' });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.parseDatevBwaXlsx).not.toHaveBeenCalled();
  });

  it('prüft die Mandanten-ID, bevor Dateibytes gelesen werden', async () => {
    const upload = xlsxUpload(1);
    const file = upload.get('file') as File;
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');

    await expect(importDatevXlsxAction({ clientId: 'kein-uuid' }, upload)).resolves.toEqual({
      ok: false,
      error: 'Validierungsfehler.',
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('verlangt eine Datei', async () => {
    await expect(importDatevXlsxAction({ clientId: CLIENT_ID }, new FormData())).resolves.toEqual({
      ok: false,
      error: 'Validierungsfehler.',
    });
  });
});
