import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TimeoutError } from '@/lib/with-timeout';

// Fachkatalog: INV-ARCHIVE-EINVOICE-001

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  readModules: vi.fn(),
  checkStaffExportLimit: vi.fn(),
  withTenantContext: vi.fn(),
  canAccessClientTx: vi.fn(),
  ensureZugferdArchive: vi.fn(),
  streamObject: vi.fn(),
  evidenceRecord: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/settings/modules', () => ({
  readModules: m.readModules,
  isModeModuleEnabled: (cfg: { invoiceMode: string }) => cfg.invoiceMode !== 'OFF',
}));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: m.checkStaffExportLimit,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: m.canAccessClientTx }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@taxtronik/storage', () => ({ streamObject: m.streamObject }));
vi.mock('@/server/invoicing/archive', () => ({ ensureZugferdArchive: m.ensureZugferdArchive }));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));

import { GET } from '../route';
import { archiveFailureMessage } from '@/server/invoicing/archive-failure';
import { UnsupportedInvoiceTextError } from '@/server/invoicing/zugferd';

const INVOICE_ID = '3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d';

function request() {
  return GET(new NextRequest(`http://localhost:3000/api/staff/invoices/${INVOICE_ID}/zugferd`), {
    params: Promise.resolve({ id: INVOICE_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  m.readModules.mockResolvedValue({ invoiceMode: 'IN_APP' });
  m.checkStaffExportLimit.mockResolvedValue({ ok: true });
  m.canAccessClientTx.mockResolvedValue(true);
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ invoice: { findFirst: vi.fn().mockResolvedValue({ clientId: 'client-1' }) } }),
  );
});

describe('GET /api/staff/invoices/[id]/zugferd – Fehlerabbildung', () => {
  it.each([
    ['not_found', 404],
    ['not_applicable', 404],
    ['seller_incomplete', 422],
    ['reverse_charge_seller_no_vatid', 422],
    ['buyer_incomplete', 422],
    ['status_conflict', 409],
  ] as const)('%s → %i mit Grund', async (code, status) => {
    m.ensureZugferdArchive.mockResolvedValue({ ok: false, code });

    const response = await request();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: code,
      message: archiveFailureMessage(code),
    });
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('Reverse-Charge ohne USt-IdNr der Kanzlei nennt den Grund statt 404 not_found', async () => {
    m.ensureZugferdArchive.mockResolvedValue({ ok: false, code: 'reverse_charge_seller_no_vatid' });

    const response = await request();

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('reverse_charge_seller_no_vatid');
    expect(body.message).toContain('§ 13b UStG');
  });

  it('generation_failed: Fehlertext nur im Server-Log, nicht im Body', async () => {
    m.ensureZugferdArchive.mockRejectedValue(
      new Error('ZUGFeRD-Ablage im GOBD-Object-Store fehlgeschlagen: AccessDenied bucket gobd-x'),
    );

    const response = await request();

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: 'generation_failed',
      message: archiveFailureMessage('generation_failed'),
    });
    expect(text).not.toContain('AccessDenied');
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'zugferd',
        invoiceId: INVOICE_ID,
        tenantId: 'tenant-1',
        err: 'ZUGFeRD-Ablage im GOBD-Object-Store fehlgeschlagen: AccessDenied bucket gobd-x',
      }),
      expect.any(String),
    );
  });

  it('nicht darstellbare Zeichen → 422 unsupported_text mit Zeichen und Feld, ohne Log', async () => {
    m.ensureZugferdArchive.mockRejectedValue(
      new UnsupportedInvoiceTextError([{ field: 'Position 1 – Beschreibung', characters: ['😀'] }]),
    );

    const response = await request();

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'unsupported_text',
      message:
        'Das Zeichen „😀“ (U+1F600) ist mit der eingebetteten PDF-Schrift nicht darstellbar ' +
        '(Feld: Position 1 – Beschreibung). Zeichen werden nicht still ersetzt; bitte die ' +
        'betroffenen Angaben prüfen.',
    });
    expect(m.logError).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });

  it('timeout → 504 mit fester Meldung', async () => {
    m.ensureZugferdArchive.mockRejectedValue(new TimeoutError());

    const response = await request();

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: 'timeout',
      message: archiveFailureMessage('timeout'),
    });
  });

  it('gesperrter Mandant → dieselbe 404-Antwort wie eine unbekannte Rechnung, ohne Archivpfad', async () => {
    m.canAccessClientTx.mockResolvedValue(false);

    const response = await request();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'not_found',
      message: archiveFailureMessage('not_found'),
    });
    expect(m.ensureZugferdArchive).not.toHaveBeenCalled();
  });

  it('liefert eine DRAFT-Vorschau als PDF und auditiert den Download', async () => {
    m.ensureZugferdArchive.mockResolvedValue({
      ok: true,
      bytes: Buffer.from('%PDF-1.7'),
      number: 'R-2026/001',
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="zugferd-R-2026_001.pdf"',
    );
    expect(m.ensureZugferdArchive).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      INVOICE_ID,
      { purpose: 'PREVIEW' },
    );
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'invoice.zugferd.download', resourceId: INVOICE_ID }),
    );
  });
});
