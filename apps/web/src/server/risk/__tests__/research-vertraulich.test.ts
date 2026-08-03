import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Vertraulichkeitsgrenze im Rechercheauftrag.
//
// Der „Sachverhalt-Auszug" nimmt normalerweise 500 Zeichen Kontext um die
// Markierung mit. Bei einer als vertraulich gekennzeichneten Analyse darf eine
// nur zugewiesene Person den Sachverhalt aber gar nicht sehen — dann würde
// genau dieser Kontext über den Umweg „an die KI schicken" nach draussen
// gehen, obwohl die Ansicht ihn zurückhält.
// =============================================================================

const m = vi.hoisted(() => ({ withTenantContext: vi.fn() }));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: m.withTenantContext,
  withSystemContext: vi.fn(),
}));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/n8n/outbox', () => ({ enqueueN8nEvent: vi.fn() }));
vi.mock('@/server/n8n/callback-receipts', () => ({
  claimN8nCallbackReceipt: vi.fn(),
  setN8nCallbackReceiptResult: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/notifications/service', () => ({ notify: vi.fn() }));

import { previewResearch } from '../research';

const TENANT = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };

const VORHER = 'Streng geheimer Vorspann mit Namen und Zahlen. ';
const MARKE = 'Bargeschäfte';
const NACHHER = ' Und danach folgt noch mehr Vertrauliches.';
const TEXT = VORHER + MARKE + NACHHER;

function mockTx(vertraulich: boolean) {
  const tx = {
    riskAnalysis: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'analysis-1',
        clientId: 'client-1',
        sourceText: TEXT,
        katalogVersion: 'v1',
        vertraulich,
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
    riskMarking: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'marking-1',
        begriff: 'Kassenführung',
        normAnker: ['§ 146 AO'],
        governanceTyp: null,
        start: VORHER.length,
        end: VORHER.length + MARKE.length,
      }),
    },
  };
  m.withTenantContext.mockImplementation(async (_c: unknown, fn: (t: typeof tx) => unknown) =>
    fn(tx),
  );
}

const INPUT = {
  analysisId: 'analysis-1',
  markingId: 'marking-1',
  sachverhalt: 'excerpt' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('Rechercheauftrag bei vertraulicher Analyse', () => {
  it('schickt nur die markierte Stelle — ohne Kontext davor/danach', async () => {
    mockTx(true);
    const p = await previewResearch(TENANT, INPUT, { volleAkteneinsicht: false });

    expect(p.anonymizedText).toContain(MARKE);
    expect(p.anonymizedText).not.toContain('Vorspann');
    expect(p.anonymizedText).not.toContain('Vertrauliches');
  });

  it('gibt dem Berufsträger weiterhin den vollen Auszug', async () => {
    mockTx(true);
    const p = await previewResearch(TENANT, INPUT, { volleAkteneinsicht: true });

    expect(p.anonymizedText).toContain('Vorspann');
    expect(p.anonymizedText).toContain('Vertrauliches');
  });

  it('lässt eine nicht-vertrauliche Analyse unverändert — auch ohne Schreibrecht', async () => {
    mockTx(false);
    const p = await previewResearch(TENANT, INPUT, { volleAkteneinsicht: false });

    expect(p.anonymizedText).toContain('Vorspann');
    expect(p.anonymizedText).toContain('Vertrauliches');
  });

  it('verhält sich ohne Scope-Angabe wie bisher (Default: volle Einsicht)', async () => {
    mockTx(true);
    const p = await previewResearch(TENANT, INPUT);

    expect(p.anonymizedText).toContain('Vorspann');
  });
});
