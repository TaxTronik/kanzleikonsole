// Fachkatalog: INV-LIFECYCLE-FREEZE-001, INV-VAT-TOTALS-001
// Fachkatalog: INV-STORNO-REFERENCE-001, INV-ARCHIVE-EINVOICE-001

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  tx: {
    invoice: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
  record: vi.fn(),
  resolve: vi.fn(),
  storage: vi.fn(),
  modules: vi.fn(),
  context: vi.fn(),
  guard: vi.fn(),
}));
const tenantId = '00000000-0000-4000-8000-000000000001';
const clientId = '00000000-0000-4000-8000-000000000002';
const invoiceId = '00000000-0000-4000-8000-000000000003';
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.context }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: m.resolve }));
vi.mock('@taxtronik/storage', () => ({ commitDocumentFromBytes: m.storage }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: () => 'https://portal.test' }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/documents/upload-helpers', () => ({ createDocumentWithVersion: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({ compensateStorageCommit: vi.fn() }));
vi.mock('@/server/mail/outbox', () => ({
  enqueueDirectMailTx: vi.fn(),
  kickMailOutboxDelivery: vi.fn(),
}));
vi.mock('@/server/invoicing/archive', () => ({ ensureZugferdArchive: vi.fn() }));
vi.mock('@/server/settings/modules', () => ({ readModules: m.modules }));
vi.mock('@/server/settings/tenant-settings', () => ({ readSellerInfo: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/invoicing/number', async (original) => ({
  ...(await original<typeof import('../number')>()),
  allocateInvoiceNumber: vi.fn().mockResolvedValue('2026-0001'),
}));
vi.mock('@/server/actions/staff-action', async () => {
  const staffActionGuard = (options?: unknown) => m.guard(options);
  return {
    ActionError: (await import('@/server/actions/action-error')).ActionError,
    staffActionGuard,
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: (
      await vi.importActual<typeof import('@/server/actions/action-runner')>(
        '@/server/actions/action-runner',
      )
    ).createActionRunner(staffActionGuard),
    withStaff: async (fn: (tx: unknown, ctx: unknown) => Promise<void>) => {
      try {
        await fn(m.tx, {
          tenantId,
          staffId: 'staff',
          ctx: { tenantId, actorId: 'staff', actorType: 'STAFF' },
          session: {},
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    parseFormData: (schema: { parse(input: unknown): unknown }, data: FormData) => ({
      ok: true,
      data: schema.parse(Object.fromEntries(data)),
    }),
  };
});

import {
  cancelInvoiceAction,
  createInvoiceAction,
  markPaidAction,
  markSentAction,
  uploadExternalInvoiceAction,
} from '@/app/staff/(protected)/invoices/actions';
import { log } from '@/server/logger';
import { ensureZugferdArchive } from '@/server/invoicing/archive';
import { UnsupportedInvoiceTextError } from '@/server/invoicing/zugferd';

beforeEach(() => {
  vi.clearAllMocks();
  m.guard.mockResolvedValue({
    ok: true,
    tenantId,
    staffId: 'staff',
    ctx: { tenantId, actorId: 'staff', actorType: 'STAFF' },
    session: {},
  });
  m.modules.mockResolvedValue({ invoiceMode: 'IN_APP' });
  m.context.mockImplementation(async (_ctx, fn) => fn(m.tx));
  m.tx.invoice.create.mockResolvedValue({ id: invoiceId });
  m.tx.invoice.findUnique.mockResolvedValue({ id: invoiceId, status: 'SENT', clientId });
  m.tx.invoice.findUniqueOrThrow.mockResolvedValue({
    id: invoiceId,
    status: 'PAID',
    number: '2026-0001',
    paidAt: new Date(),
  });
  m.tx.invoice.update.mockResolvedValue({ id: invoiceId, number: '2026-0001', paidAt: new Date() });
});
/** F-09: Fremdrechnungs-PDF binär als File in FormData. */
function pdfUpload() {
  const upload = new FormData();
  upload.set('pdf', new File(['%PDF-'], 'r.pdf', { type: 'application/pdf' }));
  return upload;
}
function input(quantity = 1.23, unitPrice = 100) {
  // Rechnungsjahr im laufenden Jahr ± 1; die Fälligkeit liegt danach (A4).
  const year = new Date().getUTCFullYear();
  return {
    clientId,
    subject: 'Beratung',
    issueDate: `${year}-06-01`,
    dueDate: `${year}-07-01`,
    format: 'XRECHNUNG' as const,
    positions: [{ description: 'Beratung', quantity, unitPrice, unit: 'Stück', vatRate: 19 }],
  };
}
describe('INV-VAT-TOTALS-001: Eingabe und gespeicherte Dezimalpräzision', () => {
  it.each([
    [1.234, 100, 'Menge'],
    [100, 1.234, 'Einzelpreis'],
  ])(
    'weist zusätzliche Nachkommastellen vor jeder Speicherung zurück (%s × %s)',
    async (quantity, price, field) => {
      await expect(
        createInvoiceAction(input(Number(quantity), Number(price))),
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining(String(field)) });
      expect(m.context).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
    },
  );
  it.each([
    [1.23, 100, 123],
    [0.1, 0.05, 0.01],
    [100000, 84033.61, 8403361000],
  ])('bewahrt zulässige Werte samt Halbcent-Rundung (%s × %s)', async (quantity, price, net) => {
    await expect(createInvoiceAction(input(quantity, price))).resolves.toMatchObject({ ok: true });
    expect(m.tx.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          positions: {
            create: [expect.objectContaining({ quantity, unitPrice: price, netAmount: net })],
          },
        }),
      }),
    );
  });
  it.each(['gross', 'net'] as const)(
    'rejects a Decimal(12,2) %s total overflow before opening a transaction',
    async (field) => {
      const data = field === 'gross' ? input(100000, 99999.99) : input(100000, 50000);
      if (field === 'net') data.positions.push({ ...data.positions[0]! });
      await expect(createInvoiceAction(data)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('Rechnungssumme'),
      });
      expect(m.context).not.toHaveBeenCalled();
      expect(m.tx.invoice.create).not.toHaveBeenCalled();
      expect(m.record).not.toHaveBeenCalled();
    },
  );
  it('weist einen externen Bruttobetrag mit Subcent-Präzision vor dem Object-Lock-Upload zurück', async () => {
    m.modules.mockResolvedValue({ invoiceMode: 'EXTERNAL' });
    await expect(
      uploadExternalInvoiceAction(
        {
          clientId,
          number: 'EXT-1',
          subject: 'Import',
          issueDate: '2026-06-01',
          dueDate: '2026-07-01',
          totalAmount: 1.234,
          vatRatePct: 19,
        },
        pdfUpload(),
      ),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Nachkommastellen') });
    expect(m.storage).not.toHaveBeenCalled();
  });
});

// Fachkatalog: INV-NUMBER-ALLOCATION-001 — Produktentscheidung A4: Fälligkeit nicht vor
// dem Rechnungsdatum auf jedem Anlagepfad, mit der Meldung des StBVV-Pfads.
describe('INV-NUMBER-ALLOCATION-001: Fälligkeit nicht vor dem Rechnungsdatum', () => {
  const external = (issueDate: string, dueDate: string) => ({
    clientId,
    number: 'EXT-1',
    subject: 'Import',
    issueDate,
    dueDate,
    totalAmount: 119,
    vatRatePct: 19,
  });

  it('weist den EXTERNAL-Upload vor dem Object-Lock-Upload zurück', async () => {
    m.modules.mockResolvedValue({ invoiceMode: 'EXTERNAL' });
    await expect(
      uploadExternalInvoiceAction(external('2026-06-02', '2026-06-01'), pdfUpload()),
    ).resolves.toEqual({ ok: false, error: 'Rechnungsdatum und Fälligkeit sind ungültig.' });
    expect(m.context).not.toHaveBeenCalled();
    expect(m.storage).not.toHaveBeenCalled();
  });

  it('weist die manuelle In-App-Rechnung vor jeder Transaktion zurück', async () => {
    const data = { ...input(), dueDate: input().issueDate.replace(/-06-01$/, '-05-31') };
    await expect(createInvoiceAction(data)).resolves.toEqual({
      ok: false,
      error: 'Rechnungsdatum und Fälligkeit sind ungültig.',
    });
    expect(m.context).not.toHaveBeenCalled();
    expect(m.tx.invoice.create).not.toHaveBeenCalled();
  });

  it('lässt eine Fälligkeit am Rechnungsdatum zu', async () => {
    const data = { ...input(), dueDate: input().issueDate };
    await expect(createInvoiceAction(data)).resolves.toMatchObject({ ok: true });
  });
});

describe('INV-LIFECYCLE-FREEZE-001: Zahlungsaction', () => {
  it('führt bei zwei veralteten SENT-Leseständen nur den gewonnenen Zahlungsclaim nach', async () => {
    m.tx.invoice.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const form = new FormData();
    form.set('invoiceId', invoiceId);
    const results = await Promise.all([markPaidAction(null, form), markPaidAction(null, form)]);
    // Review-Befund F-01: der verlorene Claim kommt als Ergebnis zurück, nicht als Wurf.
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: 'Der Rechnungsstatus hat sich geändert. Bitte die Rechnung neu laden.' },
    ]);
    expect(m.resolve).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record).toHaveBeenCalledWith(
      m.tx,
      expect.objectContaining({ action: 'invoice.paid' }),
    );
  });
});

describe('Review-Befund F-01: Rechnungsstatus meldet Ablehnungen als Ergebnis', () => {
  function statusForm(): FormData {
    const form = new FormData();
    form.set('invoiceId', invoiceId);
    return form;
  }

  it('meldet einen unzulässigen Zahlungsstatuswechsel ohne Claim und Audit', async () => {
    m.tx.invoice.findUnique.mockResolvedValue({ status: 'DRAFT', clientId });

    await expect(markPaidAction(null, statusForm())).resolves.toEqual({
      ok: false,
      error: 'Statuswechsel DRAFT → PAID ist nicht zulässig.',
    });
    expect(m.tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('meldet eine unbekannte Rechnung, statt still Erfolg zu melden', async () => {
    m.tx.invoice.findUnique.mockResolvedValue(null);

    await expect(markPaidAction(null, statusForm())).resolves.toEqual({
      ok: false,
      error: 'Rechnung nicht gefunden.',
    });
    expect(m.tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('meldet einen unzulässigen Storno ohne Korrekturbeleg', async () => {
    const executeRaw = vi.fn();
    Object.assign(m.tx, { $executeRaw: executeRaw });
    m.tx.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      status: 'CANCELLED',
      clientId,
      positions: [],
    });

    await expect(cancelInvoiceAction(null, statusForm())).resolves.toEqual({
      ok: false,
      error: 'Statuswechsel CANCELLED → CANCELLED ist nicht zulässig.',
    });
    expect(executeRaw).toHaveBeenCalled();
    expect(m.tx.invoice.create).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});

describe('C5: Storno und Versand nennen nicht darstellbare Zeichen samt Feld', () => {
  const stornoId = '00000000-0000-4000-8000-000000000004';
  const unsupported = () =>
    new UnsupportedInvoiceTextError([{ field: 'Mandant – Name', characters: ['李', '明'] }]);
  const DETAIL =
    'Die Zeichen „李“ (U+674E), „明“ (U+660E) sind mit der eingebetteten PDF-Schrift nicht ' +
    'darstellbar (Feld: Mandant – Name). Zeichen werden nicht still ersetzt; bitte die ' +
    'betroffenen Angaben prüfen.';
  function form(): FormData {
    const data = new FormData();
    data.set('invoiceId', invoiceId);
    return data;
  }
  /** Ausgestelltes Original mit bereits angelegtem Korrekturbeleg-Entwurf. */
  function deliveredOriginalWithStornoDraft() {
    Object.assign(m.tx, { $executeRaw: vi.fn() });
    m.tx.invoice.findUnique.mockResolvedValue({
      id: invoiceId,
      status: 'SENT',
      clientId,
      format: 'XRECHNUNG',
      positions: [],
    });
    m.tx.invoice.findFirst.mockResolvedValue({ id: stornoId, status: 'DRAFT' });
  }

  it('Storno nennt Zeichen und Feld; das Original bleibt aktiv', async () => {
    deliveredOriginalWithStornoDraft();
    vi.mocked(ensureZugferdArchive).mockRejectedValue(unsupported());

    await expect(cancelInvoiceAction(null, form())).resolves.toEqual({
      ok: false,
      error: `Korrekturbeleg nicht versendet; Original bleibt aktiv: ${DETAIL}`,
    });
    expect(ensureZugferdArchive).toHaveBeenCalledWith(expect.anything(), stornoId, {
      purpose: 'ISSUE',
    });
    expect(m.tx.invoice.update).not.toHaveBeenCalled();
    expect(m.tx.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('Storno behält bei technischen Fehlern die allgemeine Meldung', async () => {
    deliveredOriginalWithStornoDraft();
    vi.mocked(ensureZugferdArchive).mockRejectedValue(new Error('S3 PutObject failed'));

    await expect(cancelInvoiceAction(null, form())).resolves.toEqual({
      ok: false,
      error:
        'Korrekturbeleg konnte nicht erzeugt werden. Das Original bleibt aktiv; der Entwurf kann erneut versendet werden.',
    });
  });

  it('Versand nennt Zeichen und Feld; die Rechnung bleibt Entwurf', async () => {
    m.tx.invoice.findUnique.mockResolvedValue({
      status: 'DRAFT',
      clientId,
      documentId: null,
      format: 'XRECHNUNG',
    });
    vi.mocked(ensureZugferdArchive).mockRejectedValue(unsupported());

    await expect(markSentAction(null, form())).resolves.toEqual({
      ok: false,
      error: `ZUGFeRD-Archiv konnte nicht erzeugt werden: ${DETAIL}`,
    });
    expect(m.tx.invoice.updateMany).not.toHaveBeenCalled();
  });
});

describe('Befund 9: Versand meldet eine Guard-Ablehnung als Ergebnis', () => {
  it('gibt die Ablehnung zurück und loggt sie strukturiert, ohne die Rechnung zu lesen', async () => {
    m.guard.mockResolvedValueOnce({ ok: false, error: 'Keine Berechtigung (INVOICE_SEND).' });
    const form = new FormData();
    form.set('invoiceId', invoiceId);

    await expect(markSentAction(null, form)).resolves.toEqual({
      ok: false,
      error: 'Keine Berechtigung (INVOICE_SEND).',
    });
    expect(m.guard).toHaveBeenCalledWith({
      requirePermission: 'INVOICE_SEND',
      modeModule: 'invoices',
    });
    expect(log.warn).toHaveBeenCalledWith(
      { component: 'invoices', action: 'markSent', err: 'Keine Berechtigung (INVOICE_SEND).' },
      'markSentAction: Guard abgelehnt',
    );
    expect(m.tx.invoice.findUnique).not.toHaveBeenCalled();
  });
});
