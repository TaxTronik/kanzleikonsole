// =============================================================================
// Prisma-Operator-Injection: Server-Action-Argumente sind zur Laufzeit nicht
// typisiert. Ein Objekt wie `{ not: '' }` statt einer Kennung wäre in
// findFirst/deleteMany ein Filteroperator. Beide Actions prüfen ihre Eingabe
// deshalb vor Guard und Datenbank; der Dienst sieht nur geprüfte UUIDs.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  guardWrite: vi.fn(),
  deletePromptTemplate: vi.fn(),
  getLlmStatus: vi.fn(),
  findFirst: vi.fn(),
  jobState: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
  requireStaffSession: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ riskAnalysis: { findFirst: h.findFirst } }),
}));
vi.mock('@taxtronik/db/risk-analysis', () => ({
  lockRiskAnalysisTx: vi.fn(),
  requireWritableRiskAnalysisTx: vi.fn(),
}));
vi.mock('@taxtronik/storage', () => ({ fetchVerifiedObjectBytes: vi.fn() }));
vi.mock('@/server/documents/delivery-readiness', () => ({ documentVersionReadiness: vi.fn() }));
vi.mock('@/server/documents/upload-file', () => ({ readUploadFile: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@/server/risk', () => ({
  deletePromptTemplate: h.deletePromptTemplate,
  getLlmStatus: h.getLlmStatus,
  UnsupportedDocumentTypeError: class UnsupportedDocumentTypeError extends Error {},
}));
vi.mock('@/server/jobs/risk-analyse-queue', () => ({
  enqueueRiskAnalyseLlm: vi.fn(),
  getRiskAnalyseJobState: h.jobState,
}));
vi.mock('../doc-text', () => ({ jsonDocToText: vi.fn() }));
vi.mock('@/lib/risk-llm', () => ({ canStartLlm: vi.fn(), llmCapabilityError: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn() }));
vi.mock('@/server/actions/audit', () => ({ audit: vi.fn() }));
vi.mock('../_guards', () => ({ guard: h.guard, guardWrite: h.guardWrite }));

import { llmStatusAction } from '../actions';
import { deletePromptTemplateAction } from '../research-actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '22222222-2222-4222-8222-222222222222';
const ANALYSIS_ID = '33333333-3333-4333-8333-333333333333';
const CTX = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' };

// Typisierte Aufrufer können das nicht senden — ein manipulierter POST schon.
const OPERATOR = { not: '00000000-0000-0000-0000-000000000000' } as unknown as string;

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({ ctx: CTX, staffId: 'staff-1' });
  h.guardWrite.mockResolvedValue({ ctx: CTX, staffId: 'staff-1' });
  h.deletePromptTemplate.mockResolvedValue(undefined);
  h.getLlmStatus.mockResolvedValue(null);
  h.findFirst.mockResolvedValue(null);
  h.jobState.mockResolvedValue(null);
});

describe('deletePromptTemplateAction', () => {
  it('löscht eine Vorlage über ihre geprüfte UUID', async () => {
    await expect(
      deletePromptTemplateAction({ clientId: CLIENT_ID, id: TEMPLATE_ID }),
    ).resolves.toEqual({ ok: true });
    expect(h.guardWrite).toHaveBeenCalledWith(CLIENT_ID);
    expect(h.deletePromptTemplate).toHaveBeenCalledWith(CTX, TEMPLATE_ID);
  });

  it.each([
    ['Operator-Objekt als id', { clientId: CLIENT_ID, id: OPERATOR }],
    ['Liste als id', { clientId: CLIENT_ID, id: [TEMPLATE_ID] as unknown as string }],
    ['Operator-Objekt als clientId', { clientId: OPERATOR, id: TEMPLATE_ID }],
  ])('%s: Validierungsfehler ohne Guard und ohne deleteMany', async (_name, input) => {
    await expect(deletePromptTemplateAction(input)).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
    });
    expect(h.guardWrite).not.toHaveBeenCalled();
    expect(h.deletePromptTemplate).not.toHaveBeenCalled();
  });
});

describe('llmStatusAction', () => {
  it('liest den Fertig-Status nur für die geprüfte Analyse', async () => {
    await expect(
      llmStatusAction({ clientId: CLIENT_ID, analysisId: ANALYSIS_ID }),
    ).resolves.toMatchObject({ ok: true, enrichedAt: null });
    expect(h.guard).toHaveBeenCalledWith(CLIENT_ID);
    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: ANALYSIS_ID, clientId: CLIENT_ID },
      select: { llmEnrichedAt: true },
    });
  });

  it('kommt ohne analysisId ohne Analyse-Lookup aus', async () => {
    await expect(llmStatusAction({ clientId: CLIENT_ID })).resolves.toMatchObject({ ok: true });
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['Operator-Objekt als analysisId', { clientId: CLIENT_ID, analysisId: OPERATOR }],
    ['Operator-Objekt als clientId', { clientId: OPERATOR, analysisId: ANALYSIS_ID }],
  ])('%s: Validierungsfehler ohne Guard und ohne findFirst', async (_name, input) => {
    await expect(llmStatusAction(input)).resolves.toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
    });
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.jobState).not.toHaveBeenCalled();
  });
});
