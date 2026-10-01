// Fachkatalog: ACCESS-CLIENT-MODE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  requireSubsumtionAccess: vi.fn(),
  canWriteClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  checkStaffExportLimit: vi.fn(),
  readModules: vi.fn(),
  buildReportModel: vi.fn(),
  renderDocx: vi.fn(),
  renderPdf: vi.fn(),
  evidenceRecord: vi.fn(),
  tx: { riskAnalysis: { findUnique: vi.fn() } },
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({
  requireSubsumtionAccess: h.requireSubsumtionAccess,
  canWriteClientTx: h.canWriteClientTx,
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
  checkStaffExportLimit: h.checkStaffExportLimit,
}));
vi.mock('@/server/settings/modules', () => ({ readModules: h.readModules }));
vi.mock('@/server/risk/export/report-model', () => ({ buildReportModel: h.buildReportModel }));
vi.mock('@/server/risk/export/to-docx', () => ({ renderDocx: h.renderDocx }));
vi.mock('@/server/risk/export/to-pdf', () => ({ renderPdf: h.renderPdf }));
// Keep the real storage filename sanitizer and NextResponse/Headers implementation.
// No storage request is made; only the module's client configuration is synthetic.
vi.mock('@taxtronik/config', () => ({
  env: {
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'local',
    S3_ACCESS_KEY: 'synthetic',
    S3_SECRET_KEY: 'synthetic',
  },
}));

import { GET } from '../route';

const TITLE = 'Analyse 分析 Отчёт';
const BYTES = Buffer.from('synthetic rendered report');
const call = (format: string) =>
  GET(
    new NextRequest(
      `https://local.test/api/staff/clients/client-1/subsumtion/analysis-1/export?format=${format}`,
    ),
    {
      params: Promise.resolve({ id: 'client-1', analysisId: 'analysis-1' }),
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } };
  h.staffAuth.mockResolvedValue(session);
  h.requireSubsumtionAccess.mockResolvedValue(session);
  h.canWriteClientTx.mockResolvedValue(true);
  h.withTenantContext.mockImplementation(async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run(h.tx),
  );
  h.checkStaffExportLimit.mockResolvedValue({ ok: true });
  h.readModules.mockResolvedValue({ risk: true });
  h.tx.riskAnalysis.findUnique.mockResolvedValue({ clientId: 'client-1', vertraulich: false });
  h.buildReportModel.mockResolvedValue({ title: TITLE });
  h.renderDocx.mockResolvedValue(BYTES);
  h.renderPdf.mockResolvedValue(BYTES);
  h.evidenceRecord.mockResolvedValue(undefined);
});

describe('authorized report export with international filenames', () => {
  it.each([
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['pdf', 'application/pdf'],
  ])(
    'returns a real %s response with a safe fallback and the original UTF-8 filename',
    async (format, mimeType) => {
      const response = await call(format);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
      expect(response.headers.get('content-type')).toBe(mimeType);
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="Analyse __ _____.${format}"; filename*=UTF-8''${encodeURIComponent(`${TITLE}.${format}`)}`,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(h.requireSubsumtionAccess).toHaveBeenCalledExactlyOnceWith('client-1');
      expect(format === 'pdf' ? h.renderPdf : h.renderDocx).toHaveBeenCalledExactlyOnceWith({
        title: TITLE,
      });
      expect(format === 'pdf' ? h.renderDocx : h.renderPdf).not.toHaveBeenCalled();
      expect(h.evidenceRecord).toHaveBeenCalledExactlyOnceWith(
        h.tx,
        expect.objectContaining({
          action: 'subsumtion.report.export',
          resourceId: 'analysis-1',
          after: { clientId: 'client-1', format, markings: null },
        }),
      );
    },
  );

  it('does not render or audit an analysis belonging to another client', async () => {
    h.tx.riskAnalysis.findUnique.mockResolvedValue({
      clientId: 'other-client',
      vertraulich: false,
    });
    expect((await call('docx')).status).toBe(404);
    expect(h.buildReportModel).not.toHaveBeenCalled();
    expect(h.renderDocx).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });

  it('does not split a supplementary Unicode letter at the filename length limit', async () => {
    const title = `${'A'.repeat(79)}𠮷remaining`;
    h.buildReportModel.mockResolvedValue({ title });
    const response = await call('docx');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${'A'.repeat(79)}__.docx"; filename*=UTF-8''${encodeURIComponent(`${'A'.repeat(79)}𠮷.docx`)}`,
    );
  });

  it('does not render or audit a confidential analysis without write access', async () => {
    h.tx.riskAnalysis.findUnique.mockResolvedValue({ clientId: 'client-1', vertraulich: true });
    h.canWriteClientTx.mockResolvedValue(false);
    expect((await call('pdf')).status).toBe(403);
    expect(h.canWriteClientTx).toHaveBeenCalledExactlyOnceWith(
      h.tx,
      { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
      'client-1',
    );
    expect(h.buildReportModel).not.toHaveBeenCalled();
    expect(h.renderPdf).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
  });
});
