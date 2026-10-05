// Review-Befund F-14: Die Badges der Portal-Startseite zählen per count() mit
// exakt den Filtern der dort gekappten Listen; gekappte Listen zeigen einen
// Hinweis mit Link auf die vollständige Liste.
//
// Fachkatalog: REQ-LIFECYCLE-001, TAX-NOTICE-DECISION-001 — persönlich
// gebundene Bescheid-/Feedbackanfragen erscheinen nicht als allgemeine
// Anforderung (auch nicht für andere Kontakte); der gebundene Kontakt sieht
// seine offene Rückfrage als eigenes To-do. Formulare gelten wie unter
// /portal/forms nur als offen, solange ihre Anforderung offen ist.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Modules = {
  forms: boolean;
  invoiceMode: string;
  noticeDecisions: boolean;
  taxNotices: boolean;
  feedbackSurveys: boolean;
};

const h = vi.hoisted(() => ({
  modules: {} as Modules,
  tx: {
    $queryRaw: vi.fn(),
    request: { count: vi.fn(), findMany: vi.fn() },
    document: { count: vi.fn() },
    formSubmission: { findMany: vi.fn() },
    invoice: { count: vi.fn(), findMany: vi.fn() },
    clientInteraction: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => ({
    user: {
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      clientId: 'client-1',
      fullName: 'Erika Mustermann',
    },
  })),
}));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn(async () => h.modules) }));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeatures: vi.fn(async () => ({ clientInbox: false })),
}));
vi.mock('@/server/inbox/queries', () => ({ countPortalInboxNeedsClientTx: vi.fn() }));
// Nur das Snapshot-Schema wird gebraucht; das Modul zieht sonst Auth/Next nach.
vi.mock('@/server/workflows/interactions', async () => {
  const { z } = await import('zod');
  return { noticeDecisionSnapshot: z.object({ version: z.literal(1), title: z.string() }) };
});
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx)),
}));

import PortalDashboardPage from '../page';

function rows(count: number, make: (index: number) => Record<string, unknown>) {
  return Array.from({ length: count }, (_, index) => make(index));
}

function openForm(index: number) {
  return {
    id: `form-${index}`,
    status: 'PENDING',
    requestId: `form-req-${index}`,
    template: { name: `Formular ${index}` },
    requests: [{ id: `form-req-${index}`, status: 'OPEN' }],
  };
}

const NOTICE_SNAPSHOT = {
  version: 1,
  title: 'Rückfrage zum Einkommensteuerbescheid 2025',
  explanation: 'Bitte prüfen.',
  noticeUpdatedAt: '2026-09-01T00:00:00.000Z',
  documentId: '00000000-0000-4000-8000-000000000001',
  documentVersionId: '00000000-0000-4000-8000-000000000002',
  documentSha256: 'a'.repeat(64),
  assessedAmount: null,
  appealDeadline: '2026-10-30',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.modules = {
    forms: true,
    invoiceMode: 'FULL',
    noticeDecisions: true,
    taxNotices: true,
    feedbackSurveys: true,
  };
  h.tx.$queryRaw.mockResolvedValue([]);
  h.tx.request.count.mockResolvedValue(14);
  h.tx.request.findMany.mockImplementation(async (args: { take: number }) =>
    rows(Math.min(args.take, 14), (i) => ({
      id: `req-${i}`,
      title: `Anforderung ${i}`,
      status: 'OPEN',
      dueAt: null,
    })),
  );
  h.tx.document.count.mockResolvedValue(3);
  h.tx.formSubmission.findMany.mockResolvedValue(rows(12, openForm));
  h.tx.invoice.count.mockResolvedValue(7);
  h.tx.invoice.findMany.mockResolvedValue(
    rows(5, (i) => ({
      id: `inv-${i}`,
      number: `RE-${i}`,
      dueDate: new Date('2026-10-20T00:00:00.000Z'),
      totalAmount: { toString: () => '119.00' },
      status: 'SENT',
    })),
  );
  h.tx.clientInteraction.count.mockResolvedValue(0);
  h.tx.clientInteraction.findMany.mockResolvedValue([]);
});

describe('Portal-Startseite — Zähler gekappter Listen', () => {
  it('zählt „offen“ vollständig und verweist auf die vollständigen Listen', async () => {
    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(html).toContain('<span class="badge-yellow ml-auto">26 offen</span>');
    expect(html).toContain('20 von 26 angezeigt');
    expect(html).toContain('href="/portal/requests"');
    expect(html).toContain('>Alle Anforderungen</a>');
    expect(html).toContain('>Alle Formulare</a>');
    expect(html).toContain('<span class="badge-yellow">7</span>');
    expect(html).toContain('5 von 7 angezeigt');
  });

  it('verwendet für jeden Zähler exakt den Filter der zugehörigen Liste', async () => {
    await PortalDashboardPage();

    const requestCountWhere = h.tx.request.count.mock.calls[0]![0].where;
    const todoRequestArgs = h.tx.request.findMany.mock.calls.find(([args]) => args.take === 10)![0];
    expect(todoRequestArgs.where).toEqual(requestCountWhere);
    expect(requestCountWhere).toEqual({
      clientId: 'client-1',
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    });
    expect(h.tx.invoice.findMany.mock.calls[0]![0].where).toEqual(
      h.tx.invoice.count.mock.calls[0]![0].where,
    );
    expect(h.tx.clientInteraction.findMany.mock.calls[0]![0].where).toEqual(
      h.tx.clientInteraction.count.mock.calls[0]![0].where,
    );
  });

  it('zeigt ohne Kappung keinen Ausschnitt-Hinweis', async () => {
    h.tx.request.count.mockResolvedValue(2);
    h.tx.formSubmission.findMany.mockResolvedValue(rows(1, openForm));
    h.tx.invoice.count.mockResolvedValue(5);

    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(html).toContain('3 offen</span>');
    expect(html).not.toContain('angezeigt');
  });

  it('fragt bei abgeschaltetem Formular-, Rechnungs- und Rückfragemodul nichts davon ab', async () => {
    h.modules = {
      forms: false,
      invoiceMode: 'OFF',
      noticeDecisions: false,
      taxNotices: true,
      feedbackSurveys: false,
    };

    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(h.tx.formSubmission.findMany).not.toHaveBeenCalled();
    expect(h.tx.invoice.count).not.toHaveBeenCalled();
    expect(h.tx.clientInteraction.count).not.toHaveBeenCalled();
    expect(h.tx.clientInteraction.findMany).not.toHaveBeenCalled();
    expect(html).toContain('14 offen</span>');
    expect(html).toContain('10 von 14 angezeigt');
    expect(html).not.toContain('Alle Formulare');
  });
});

describe('Portal-Startseite — persönliche Rückfragen (REQ-LIFECYCLE-001)', () => {
  it('zählt und listet an Rückfragen gebundene Anforderungen nicht als allgemeine Anforderung', async () => {
    h.tx.$queryRaw.mockResolvedValue([{ id: 'interaction-req-1' }, { id: 'interaction-req-2' }]);

    await PortalDashboardPage();

    const [sql] = h.tx.$queryRaw.mock.calls[0]!;
    expect((sql as TemplateStringsArray).join('?')).toContain('app.interaction_request(r.id)');
    const excluded = { notIn: ['interaction-req-1', 'interaction-req-2'] };
    expect(h.tx.request.count.mock.calls[0]![0].where).toEqual({
      clientId: 'client-1',
      id: excluded,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    });
    for (const [args] of h.tx.request.findMany.mock.calls) {
      expect(args.where.id).toEqual(excluded);
    }
  });

  it('zeigt dem gebundenen Kontakt seine offene Rückfrage als To-do mit Link auf /portal/interactions', async () => {
    h.tx.request.count.mockResolvedValue(0);
    h.tx.request.findMany.mockResolvedValue([]);
    h.tx.formSubmission.findMany.mockResolvedValue([]);
    h.tx.clientInteraction.count.mockResolvedValue(2);
    h.tx.clientInteraction.findMany.mockResolvedValue([
      {
        id: 'interaction-1',
        kind: 'NOTICE',
        snapshot: NOTICE_SNAPSHOT,
        expiresAt: new Date('2026-10-25T10:00:00.000Z'),
      },
      {
        id: 'interaction-2',
        kind: 'FEEDBACK',
        snapshot: {},
        expiresAt: new Date('2026-11-01T10:00:00.000Z'),
      },
    ]);

    const html = renderToStaticMarkup(await PortalDashboardPage());

    const where = h.tx.clientInteraction.count.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      clientId: 'client-1',
      contactId: 'contact-1',
      status: 'OPEN',
      kind: { in: ['NOTICE', 'FEEDBACK'] },
    });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(html).toContain('2 offen</span>');
    expect(html).toContain('href="/portal/interactions"');
    expect(html).toContain('Rückfrage zum Einkommensteuerbescheid 2025');
    expect(html).toContain('Wie zufrieden sind Sie mit unserer Zusammenarbeit?');
    expect(html).toContain('Antwort bis');
  });

  it('nimmt Bescheid-Rückfragen nur mit Bescheidmodul auf', async () => {
    h.modules = { ...h.modules, taxNotices: false };

    await PortalDashboardPage();

    expect(h.tx.clientInteraction.count.mock.calls[0]![0].where.kind).toEqual({
      in: ['FEEDBACK'],
    });
  });
});

describe('Portal-Startseite — offene Formulare wie /portal/forms', () => {
  it('zählt Formulare mit geschlossener oder fehlender Anforderung nicht als offen', async () => {
    h.tx.request.count.mockResolvedValue(0);
    h.tx.request.findMany.mockResolvedValue([]);
    h.tx.formSubmission.findMany.mockResolvedValue([
      openForm(1),
      { ...openForm(2), requests: [{ id: 'form-req-2', status: 'CLOSED' }] },
      { ...openForm(3), requests: [] },
      { ...openForm(4), requestId: null, requests: [{ id: 'legacy', status: 'CANCELLED' }] },
      { ...openForm(5), status: 'DRAFT' },
    ]);

    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(h.tx.formSubmission.findMany.mock.calls[0]![0].where).toEqual({
      clientId: 'client-1',
      status: { in: ['PENDING', 'DRAFT'] },
    });
    expect(html).toContain('2 offen</span>');
    expect(html).toContain('Formular 1');
    expect(html).toContain('Formular 5');
    expect(html).not.toContain('Formular 2');
    expect(html).not.toContain('Formular 3');
    expect(html).not.toContain('Formular 4');
  });
});
