import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  accessibleClientsWhereFor: vi.fn(),
  evidenceRecord: vi.fn(),
  notifyClientContacts: vi.fn(),
  fireAndForget: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/mail/dispatch', () => ({ notifyClientContacts: mocks.notifyClientContacts }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: mocks.fireAndForget }));
vi.mock('@/server/auth/rbac', () => ({
  assertClientAccessTx: mocks.assertClientAccessTx,
  accessibleClientsWhereFor: mocks.accessibleClientsWhereFor,
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler',
  }),
}));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
  staffActionGuard: mocks.staffActionGuard,
}));

import {
  createQuickRequestAction,
  createRequestAction,
  searchRequestClientsAction,
} from '../actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const FORM_TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';

function requestData(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('requestId', REQUEST_ID);
  data.set('clientId', CLIENT_ID);
  data.set('title', 'Belege Juli');
  data.set('description', 'Bitte die Belege für Juli bereitstellen.');
  data.set('priority', 'HIGH');
  // Zeitzonenloser datetime-local-Stempel (Berlin-Wanduhr) — wie das native
  // <input type="datetime-local"> ihn seit dem Picker-Umbau liefert.
  data.set('dueAt', '2026-07-31T10:00');
  for (const [key, value] of Object.entries(overrides)) data.set(key, value);
  return data;
}

function makeTx() {
  return {
    $executeRaw: vi.fn(),
    requestTemplate: { findFirst: vi.fn() },
    formTemplate: { findFirst: vi.fn() },
    formSubmission: { create: vi.fn(), update: vi.fn() },
    auditLog: { findFirst: vi.fn() },
    client: { findMany: vi.fn() },
    request: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: REQUEST_ID }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
  });
  mocks.evidenceRecord.mockResolvedValue({});
  mocks.notifyClientContacts.mockResolvedValue(undefined);
  mocks.accessibleClientsWhereFor.mockResolvedValue({});
});

describe('Mandantensuche für Quick-Anforderungen', () => {
  it('sucht serverseitig und liefert aktive wie GwG-ausstehende Mandanten mit Status', async () => {
    const tx = makeTx();
    tx.client.findMany.mockResolvedValue([
      {
        id: CLIENT_ID,
        name: 'Aktive GmbH',
        datevNo: '1001',
        addisonNo: null,
        allowActive: true,
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Onboarding GbR',
        datevNo: null,
        addisonNo: null,
        allowActive: false,
      },
    ]);
    const accessWhere = {
      responsibilities: { some: { staffId: 'staff-1' } },
    };
    mocks.accessibleClientsWhereFor.mockResolvedValue(accessWhere);
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await searchRequestClientsAction('gmbh');

    expect(result).toEqual({
      ok: true,
      clients: [
        {
          id: CLIENT_ID,
          name: 'Aktive GmbH',
          datevNo: '1001',
          addisonNo: null,
          allowActive: true,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          name: 'Onboarding GbR',
          datevNo: null,
          addisonNo: null,
          allowActive: false,
        },
      ],
      limited: false,
    });
    expect(mocks.accessibleClientsWhereFor).toHaveBeenCalledWith(tx, expect.anything());
    expect(tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          anonymizedAt: null,
          AND: [accessWhere],
          OR: [
            { name: { contains: 'gmbh', mode: 'insensitive' } },
            { datevNo: { contains: 'gmbh', mode: 'insensitive' } },
            { addisonNo: { contains: 'gmbh', mode: 'insensitive' } },
          ],
        }),
        orderBy: [{ allowActive: 'desc' }, { name: 'asc' }],
        take: 21,
        select: expect.objectContaining({ allowActive: true }),
      }),
    );
  });

  it('weist überlange Suchbegriffe vor Auth und Datenbankzugriff ab', async () => {
    const result = await searchRequestClientsAction('x'.repeat(101));

    expect(result).toEqual({ ok: false, error: 'Der Suchbegriff ist zu lang.' });
    expect(mocks.staffActionGuard).not.toHaveBeenCalled();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });
});

describe('Quick-Anforderung', () => {
  it('verwendet Access-Gate, Transaktion, Audit und denselben Benachrichtigungspfad', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await createQuickRequestAction(null, requestData());

    expect(result).toMatchObject({ ok: true, requestId: REQUEST_ID, clientId: CLIENT_ID });
    expect(result.nextRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.nextRequestId).not.toBe(REQUEST_ID);
    expect(mocks.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), CLIENT_ID);
    expect(tx.request.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: REQUEST_ID,
        clientId: CLIENT_ID,
        title: 'Belege Juli',
        description: 'Bitte die Belege für Juli bereitstellen.',
        priority: 'HIGH',
        // 10:00 Berlin-Sommerzeit = 08:00 UTC (berlinWallClockToUtc)
        dueAt: new Date('2026-07-31T08:00:00.000Z'),
      }),
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'request.create', resourceId: REQUEST_ID }),
    );
    expect(mocks.notifyClientContacts).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        n8nEvent: 'request.opened',
        n8nPayload: expect.objectContaining({ requestId: REQUEST_ID }),
      }),
    );
    expect(mocks.fireAndForget).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('liefert einen bereits erstellten Request idempotent ohne doppelte Seiteneffekte zurück', async () => {
    const tx = makeTx();
    tx.request.findFirst.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      createdByStaff: 'staff-1',
      title: 'Belege Juli',
      description: 'Bitte die Belege für Juli bereitstellen.',
      priority: 'HIGH',
      dueAt: new Date('2026-07-31T08:00:00.000Z'),
      formSubmission: null,
    });
    tx.auditLog.findFirst.mockResolvedValue({ after: { templateId: null } });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await createQuickRequestAction(null, requestData());

    expect(result).toMatchObject({ ok: true, requestId: REQUEST_ID, clientId: CLIENT_ID });
    expect(result.nextRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(tx.formSubmission.create).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
  });

  it('weist eine Wiederholung derselben ID mit abweichender Payload als Konflikt ab', async () => {
    const tx = makeTx();
    tx.request.findFirst.mockResolvedValue({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      createdByStaff: 'staff-1',
      title: 'Belege Juli',
      description: 'Bitte die Belege für Juli bereitstellen.',
      priority: 'HIGH',
      dueAt: new Date('2026-07-31T08:00:00.000Z'),
      formSubmission: null,
    });
    tx.auditLog.findFirst.mockResolvedValue({ after: { templateId: null } });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await createQuickRequestAction(
      null,
      requestData({ title: 'Andere Anforderung' }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Diese Erstellungs-ID wurde bereits mit anderen Angaben verwendet. Bitte Formular neu laden.',
    });
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
  });

  it('weist ein inzwischen deaktiviertes Formular klar und ohne Teilanlage ab', async () => {
    const tx = makeTx();
    tx.formTemplate.findFirst.mockResolvedValue({
      id: FORM_TEMPLATE_ID,
      name: 'Unterlagen',
      active: false,
    });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await createQuickRequestAction(
      null,
      requestData({ formTemplateId: FORM_TEMPLATE_ID }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'Das ausgewählte Formular ist nicht mehr aktiv. Bitte Auswahl aktualisieren.',
    });
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(tx.formSubmission.create).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('weist eine inzwischen deaktivierte Anforderungsvorlage ohne Teilanlage ab', async () => {
    const tx = makeTx();
    tx.requestTemplate.findFirst.mockResolvedValue(null);
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await createQuickRequestAction(
      null,
      requestData({ templateId: FORM_TEMPLATE_ID }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Die ausgewählte Anforderungsvorlage ist nicht mehr aktiv. Bitte Auswahl aktualisieren.',
    });
    expect(tx.request.create).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('liefert das bestehende GwG-Gate als Dialogfehler zurück und benachrichtigt niemanden', async () => {
    mocks.withTenantContext.mockRejectedValue(new Error('GwG-Schranke: Mandant inaktiv'));

    const result = await createQuickRequestAction(null, requestData());

    expect(result).toEqual({
      ok: false,
      error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).',
    });
    expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('führt bei ungültigen Pflichtfeldern keine Transaktion aus', async () => {
    const result = await createQuickRequestAction(null, requestData({ title: '' }));

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.['title']).toBeDefined();
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
  });

  it('nutzt auf der Vollseite denselben Kern und redirectet erst nach Erfolg', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );
    mocks.redirect.mockImplementation(() => {
      throw new Error('NEXT_REDIRECT');
    });

    await expect(createRequestAction(null, requestData())).rejects.toThrow('NEXT_REDIRECT');

    expect(tx.request.create).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith(`/staff/clients/${CLIENT_ID}`);
  });
});
