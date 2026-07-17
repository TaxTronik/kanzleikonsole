import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Payload-Vertrag von sendResearchToN8n: n8n-Workflows bauen auf diese Felder.
// Insbesondere `auftrag` muss die Recherche-Frage SEPARAT (und anonymisiert)
// tragen — vorher steckte sie nur als "Auftrag: …"-Suffix im kombinierten
// anonymizedText und musste in n8n per String-Parsing extrahiert werden.
// =============================================================================

const m = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  enqueueN8nEvent: vi.fn(),
  evidenceRecord: vi.fn(),
}));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: m.withTenantContext,
  withSystemContext: vi.fn(),
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/n8n/outbox', () => ({ enqueueN8nEvent: m.enqueueN8nEvent }));
vi.mock('@/server/n8n/callback-receipts', () => ({
  claimN8nCallbackReceipt: vi.fn(),
  setN8nCallbackReceiptResult: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/notifications/service', () => ({ notify: vi.fn() }));

import { sendResearchToN8n } from '../research';

const TENANT = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };

function makeTx() {
  return {
    riskAnalysis: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'analysis-1',
        clientId: 'client-1',
        sourceText: 'Sachverhalt: Die Muster GmbH hat Einnahmen nicht erfasst.',
        katalogVersion: 'v1',
      }),
    },
    client: {
      findFirst: vi.fn().mockResolvedValue({
        name: 'Muster GmbH',
        datevNo: null,
        addisonNo: null,
        vatId: null,
        street: null,
        postalCode: null,
        city: null,
      }),
    },
    clientContact: { findMany: vi.fn().mockResolvedValue([]) },
    riskMarking: { findFirst: vi.fn() },
    riskResearchRequest: {
      create: vi.fn().mockResolvedValue({ id: 'req-1' }),
      update: vi.fn(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enqueueN8nEvent.mockResolvedValue({ status: 'PENDING' });
  m.withTenantContext.mockImplementation(
    async (_ctx: unknown, fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx()),
  );
});

describe('sendResearchToN8n — Payload-Vertrag', () => {
  it('sendet den Auftrag als eigenes, anonymisiertes Feld', async () => {
    await sendResearchToN8n(TENANT, {
      analysisId: 'analysis-1',
      markingId: null,
      sachverhalt: 'full',
      prompt: 'Recherchiere die Schätzungsbefugnis bei der Muster GmbH.',
      finalText: 'Sachverhalt: [MANDANT_1] hat Einnahmen nicht erfasst.',
      finalPrompt: 'Recherchiere die Schätzungsbefugnis bei [MANDANT_1].',
    });

    expect(m.enqueueN8nEvent).toHaveBeenCalledWith(
      'risk.research_requested',
      expect.objectContaining({
        researchRequestId: 'req-1',
        anonymizedText: expect.any(String),
        auftrag: expect.stringContaining('Schätzungsbefugnis'),
      }),
      { tenantId: TENANT.tenantId },
    );
    // Anonymisierung des Auftrags: der Mandantenname darf nicht im Klartext raus.
    const payload = m.enqueueN8nEvent.mock.calls[0]?.[1] as { auftrag: string } | undefined;
    expect(payload?.auftrag).not.toContain('Muster GmbH');
  });

  it('sendet auftrag=null, wenn keine Recherche-Frage erfasst wurde', async () => {
    await sendResearchToN8n(TENANT, {
      analysisId: 'analysis-1',
      markingId: null,
      sachverhalt: 'full',
      prompt: '  ',
      finalText: 'Sachverhalt: [MANDANT_1].',
      finalPrompt: null,
    });

    expect(m.enqueueN8nEvent).toHaveBeenCalledWith(
      'risk.research_requested',
      expect.objectContaining({ auftrag: null }),
      { tenantId: TENANT.tenantId },
    );
  });

  it('verdoppelt das Sachverhalt-Label nicht, wenn der Quelltext bereits damit beginnt', async () => {
    const preview = await import('../research').then((mod) =>
      mod.previewResearch(TENANT, {
        analysisId: 'analysis-1',
        markingId: null,
        sachverhalt: 'full',
        prompt: null,
      }),
    );
    expect(preview.anonymizedText).not.toMatch(/Sachverhalt:\s*\n?\s*Sachverhalt:/);
  });

  it('ersetzt den Hauptsachverhalt durch den eigenen Recherche-Sachverhalt', async () => {
    const preview = await import('../research').then((mod) =>
      mod.previewResearch(TENANT, {
        analysisId: 'analysis-1',
        markingId: null,
        sachverhalt: 'custom',
        snippets: ['Nur die Zahlung vom 15. Mai ist zu beurteilen.'],
        prompt: 'Prüfe die Festsetzungsfrist.',
      }),
    );

    expect(preview.anonymizedText).toContain('Sachverhalt für diese Recherche:');
    expect(preview.anonymizedText).toContain('Nur die Zahlung vom 15. Mai');
    expect(preview.anonymizedText).not.toContain('Einnahmen nicht erfasst');
    expect(preview.anonymizedText).not.toContain('Festsetzungsfrist');
    expect(preview.anonymizedPrompt).toBe('Prüfe die Festsetzungsfrist.');
  });
});
