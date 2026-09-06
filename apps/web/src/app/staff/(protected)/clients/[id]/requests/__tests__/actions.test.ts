// Fachkatalog: REQ-LIFECYCLE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  accessibleClientsWhereFor: vi.fn(),
  evidenceRecord: vi.fn(),
  resolveNotificationsTx: vi.fn(),
  notifyClientContacts: vi.fn(),
  notifyRequestOpened: vi.fn(),
  fireAndForget: vi.fn(),
  emitN8nEvent: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({
  resolveNotificationsTx: mocks.resolveNotificationsTx,
}));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: mocks.emitN8nEvent }));
vi.mock('@/server/mail/dispatch', () => ({
  notifyClientContacts: mocks.notifyClientContacts,
  notifyRequestOpened: mocks.notifyRequestOpened,
}));
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
  parseFormData: (
    schema: {
      safeParse: (
        value: unknown,
      ) => { success: true; data: unknown } | { success: false; error: unknown };
    },
    formData: FormData,
  ) => {
    const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
    if (parsed.success) return { ok: true, data: parsed.data };
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of (
      parsed.error as { issues: Array<{ path: PropertyKey[]; message: string }> }
    ).issues) {
      const key = issue.path.join('.') || '_form';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors,
    };
  },
}));

import {
  addRequestInternalCommentAction,
  addStaffResponseAction,
  closeRequestAction,
  createQuickRequestAction,
  createRequestAction,
  reopenRequestAction,
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
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: REQUEST_ID }),
    },
    requestResponse: { create: vi.fn() },
    requestInternalComment: { create: vi.fn() },
    staffUser: { findFirst: vi.fn() },
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
  mocks.notifyRequestOpened.mockResolvedValue(undefined);
  mocks.accessibleClientsWhereFor.mockResolvedValue({});
  mocks.resolveNotificationsTx.mockResolvedValue(undefined);
});

describe('sichtbare Antworten und interne Kanzlei-Kommentare', () => {
  function commentData(message = 'Interne Rückfrage an das Team'): FormData {
    const data = new FormData();
    data.set('requestId', REQUEST_ID);
    data.set('message', message);
    data.set('body', message);
    return data;
  }

  it.each(['RESPONDED', 'CLOSED'])(
    'erlaubt interne Notizen auch bei Status %s ohne Mandantenmail',
    async (status) => {
      const tx = makeTx();
      tx.request.findUnique.mockResolvedValue({ clientId: CLIENT_ID, status });
      tx.staffUser.findFirst.mockResolvedValue({ fullName: 'Steffi Steuer' });
      tx.requestInternalComment.create.mockResolvedValue({ id: 'comment-1' });
      mocks.withTenantContext.mockImplementation(
        async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
      );

      await expect(addRequestInternalCommentAction(commentData())).resolves.toEqual({ ok: true });

      expect(tx.requestInternalComment.create).toHaveBeenCalledWith({
        data: {
          requestId: REQUEST_ID,
          authorStaffId: 'staff-1',
          authorName: 'Steffi Steuer',
          body: 'Interne Rückfrage an das Team',
        },
      });
      expect(mocks.evidenceRecord).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ action: 'request.internal_comment.create' }),
      );
      expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
      expect(mocks.fireAndForget).not.toHaveBeenCalled();
    },
  );

  it.each(['RESPONDED', 'CLOSED'])(
    'blockiert mandantensichtbare Staff-Antworten bei Status %s',
    async (status) => {
      const tx = makeTx();
      tx.request.findUnique.mockResolvedValue({ clientId: CLIENT_ID, status });
      mocks.withTenantContext.mockImplementation(
        async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
      );

      const result = await addStaffResponseAction(commentData('Sichtbare Antwort'));

      expect(result).toEqual({
        ok: false,
        error: 'Der Portal-Vorgang ist abgeschlossen. Bitte eine interne Kanzlei-Notiz verwenden.',
      });
      expect(tx.requestResponse.create).not.toHaveBeenCalled();
      expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
      expect(mocks.fireAndForget).not.toHaveBeenCalled();
    },
  );

  it('verhindert per Status-CAS eine Antwort bei parallel abgeschlossenem Vorgang', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({ clientId: CLIENT_ID, status: 'OPEN' });
    tx.request.updateMany.mockResolvedValue({ count: 0 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    const result = await addStaffResponseAction(commentData('Sichtbare Antwort'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('zwischenzeitlich abgeschlossen');
    expect(tx.requestResponse.create).not.toHaveBeenCalled();
    expect(mocks.notifyClientContacts).not.toHaveBeenCalled();
  });
});

describe('Anforderungsabschluss und Wiedereröffnung', () => {
  function lifecycleData(): FormData {
    const data = new FormData();
    data.set('requestId', REQUEST_ID);
    return data;
  }

  it('schließt per CAS und emittiert request.closed nur beim tatsächlichen Übergang', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      id: REQUEST_ID,
      clientId: CLIENT_ID,
      status: 'OPEN',
    });
    tx.request.updateMany.mockResolvedValue({ count: 1 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await closeRequestAction(lifecycleData());

    expect(tx.request.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'OPEN' },
      data: {
        status: 'CLOSED',
        closedAt: expect.any(Date),
        closedByStaff: 'staff-1',
      },
    });
    expect(mocks.emitN8nEvent).toHaveBeenCalledWith(
      'request.closed',
      { tenantId: 'tenant-1', requestId: REQUEST_ID },
      { tenantId: 'tenant-1' },
    );
  });

  it('schreibt nach verlorenem exakten Status-CAS weder stale Audit noch Close-Event', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      id: REQUEST_ID,
      clientId: CLIENT_ID,
      status: 'OPEN',
      formSubmissionId: FORM_TEMPLATE_ID,
    });
    // Zwischen Read und CAS hat ein paralleler Mandantenpfad OPEN ->
    // RESPONDED gewonnen; status=OPEN trifft danach keine Zeile mehr.
    tx.request.updateMany.mockResolvedValue({ count: 0 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await closeRequestAction(lifecycleData());

    expect(tx.request.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REQUEST_ID, status: 'OPEN' } }),
    );
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.resolveNotificationsTx).not.toHaveBeenCalled();
    expect(mocks.emitN8nEvent).not.toHaveBeenCalled();
  });

  it.each(['CLOSED', 'RESPONDED'] as const)(
    'öffnet %s auditierbar als OPEN und räumt Abschlussstempel auf',
    async (status) => {
      const tx = makeTx();
      const closedAt = status === 'CLOSED' ? new Date('2026-08-23T12:00:00.000Z') : null;
      tx.request.findUnique.mockResolvedValue({
        clientId: CLIENT_ID,
        status,
        closedAt,
      });
      tx.request.updateMany.mockResolvedValue({ count: 1 });
      mocks.withTenantContext.mockImplementation(
        async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
      );

      await reopenRequestAction(lifecycleData());

      expect(tx.request.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status },
        data: { status: 'OPEN', closedAt: null, closedByStaff: null },
      });
      expect(mocks.evidenceRecord).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: 'request.reopen',
          before: { status, closedAt },
          after: { status: 'OPEN', closedAt: null },
        }),
      );
      expect(mocks.emitN8nEvent).not.toHaveBeenCalled();
    },
  );

  it('macht ein noch nicht abgesendetes Formular nach RESPONDED wieder im Portal erreichbar', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      clientId: CLIENT_ID,
      status: 'RESPONDED',
      closedAt: null,
      formSubmissionId: FORM_TEMPLATE_ID,
    });
    tx.request.updateMany.mockResolvedValue({ count: 1 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await reopenRequestAction(lifecycleData());

    expect(tx.request.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REQUEST_ID, status: 'RESPONDED' } }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/portal/forms');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/portal/forms/${FORM_TEMPLATE_ID}`);
  });

  it('lässt CANCELLED terminal und schreibt kein Wiedereröffnungs-Audit', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      clientId: CLIENT_ID,
      status: 'CANCELLED',
      closedAt: null,
      linkedGwgIdDocumentId: '44444444-4444-4444-8444-444444444444',
    });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await reopenRequestAction(lifecycleData());

    expect(tx.request.findFirst).not.toHaveBeenCalled();
    expect(tx.request.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('lehnt das Wiederöffnen ab, wenn bereits eine aktive GwG-Folgeanforderung besteht', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      clientId: CLIENT_ID,
      status: 'CLOSED',
      closedAt: new Date('2026-08-23T12:00:00.000Z'),
      linkedGwgIdDocumentId: '44444444-4444-4444-8444-444444444444',
    });
    tx.request.findFirst.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await reopenRequestAction(lifecycleData());

    expect(tx.request.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(`/staff/requests/${REQUEST_ID}?reopenConflict=1`);
  });

  it('behandelt den parallelen Partial-Unique-Konflikt wie eine bestehende Folgeanforderung', async () => {
    const tx = makeTx();
    tx.request.findUnique.mockResolvedValue({
      clientId: CLIENT_ID,
      status: 'CLOSED',
      closedAt: new Date('2026-08-23T12:00:00.000Z'),
      linkedGwgIdDocumentId: '44444444-4444-4444-8444-444444444444',
    });
    tx.request.findFirst.mockResolvedValue(null);
    tx.request.updateMany.mockRejectedValue({
      code: 'P2002',
      meta: { constraint: 'request_gwg_id_doc_open_unique' },
    });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await reopenRequestAction(lifecycleData());

    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith(`/staff/requests/${REQUEST_ID}?reopenConflict=1`);
  });
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
    expect(mocks.notifyRequestOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        requestId: REQUEST_ID,
        title: 'Belege Juli',
        priority: 'HIGH',
        // 10:00 Berlin-Sommerzeit = 08:00 UTC (berlinWallClockToUtc)
        dueAtIso: '2026-07-31T08:00:00.000Z',
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
    expect(mocks.notifyRequestOpened).not.toHaveBeenCalled();
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
    expect(mocks.notifyRequestOpened).not.toHaveBeenCalled();
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
    expect(mocks.notifyRequestOpened).not.toHaveBeenCalled();
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
