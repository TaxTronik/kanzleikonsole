// Fachkatalog: DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// R-05: Die Textübernahme aus einem vorhandenen Mandanten-Dokument liest die
// Bytes über den gemeinsamen, prüfenden Leseweg (fetchVerifiedObjectBytes).
// S3 ist am Storage-Client gemockt; Größen- und SHA-256-Prüfung laufen echt,
// ebenso das zentrale Fehler-Mapping (toActionError, F-03).
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  audit: vi.fn(),
  extractText: vi.fn(),
  send: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Test' }) }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
  requireStaffSession: vi.fn(),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ document: { findFirst: h.findFirst } }),
}));
vi.mock('@taxtronik/db/risk-analysis', () => ({
  lockRiskAnalysisTx: vi.fn(),
  requireWritableRiskAnalysisTx: vi.fn(),
}));
vi.mock('@/server/documents/upload-file', () => ({ readUploadFile: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('@/server/risk', () => ({
  extractText: h.extractText,
  UnsupportedDocumentTypeError: class UnsupportedDocumentTypeError extends Error {},
}));
vi.mock('@/server/jobs/risk-analyse-queue', () => ({
  enqueueRiskAnalyseLlm: vi.fn(),
  getRiskAnalyseJobState: vi.fn(),
}));
vi.mock('../doc-text', () => ({ jsonDocToText: vi.fn() }));
vi.mock('@/lib/risk-llm', () => ({ canStartLlm: vi.fn(), llmCapabilityError: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn() }));
vi.mock('../_guards', () => ({
  guardWrite: async () => ({
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    staffId: 'staff-1',
  }),
}));
vi.mock('@/server/actions/audit', () => ({ audit: h.audit }));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import { importClientDocAction } from '../actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_ID = '22222222-2222-4222-8222-222222222222';
const BYTES = Buffer.from('Sachverhalt: Verkauf einer Beteiligung');

const document = () => ({
  id: DOCUMENT_ID,
  title: 'Sachverhalt',
  mimeType: 'text/plain',
  versions: [
    {
      storageBucket: 'general',
      storageKey: 'tenants/tenant-1/none/2026/10/sachverhalt.bin',
      storageVersionId: 'bound-version',
      sha256: createHash('sha256').update(BYTES).digest(),
      sizeBytes: BigInt(BYTES.length),
    },
  ],
});

function stored(bytes: Buffer, contentLength = bytes.length) {
  h.send.mockResolvedValueOnce({ Body: Readable.from([bytes]), ContentLength: contentLength });
}

const call = () => importClientDocAction({ clientId: CLIENT_ID, documentId: DOCUMENT_ID });

beforeEach(() => {
  vi.clearAllMocks();
  h.findFirst.mockResolvedValue(document());
  h.audit.mockResolvedValue({});
  h.extractText.mockResolvedValue('Verkauf einer Beteiligung');
});

describe('Textübernahme aus Mandanten-Dokument über den geprüften Leseweg (R-05)', () => {
  it('extrahiert aus den Bytes der gebundenen Fassung nach Größen- und SHA-256-Prüfung', async () => {
    stored(BYTES);

    await expect(call()).resolves.toEqual({
      ok: true,
      text: 'Verkauf einer Beteiligung',
      suggestedTitle: 'Sachverhalt',
    });
    expect(h.extractText).toHaveBeenCalledWith(BYTES, 'text/plain');
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'general',
      Key: 'tenants/tenant-1/none/2026/10/sachverhalt.bin',
      VersionId: 'bound-version',
    });
  });

  it.each([
    ['abweichende Bytes gleicher Länge', Buffer.from('Sachverhalt: Verkauf einer BETEILIGUNG')],
    ['zusätzliche Bytes', Buffer.concat([BYTES, Buffer.from(' und mehr')])],
  ])('weist %s mit der zentralen Integritätsmeldung ab', async (_case, bytes) => {
    stored(bytes, BYTES.length);

    await expect(call()).resolves.toEqual({
      ok: false,
      error: 'Dateiintegrität konnte nicht bestätigt werden.',
    });
    expect(h.extractText).not.toHaveBeenCalled();
  });
});
