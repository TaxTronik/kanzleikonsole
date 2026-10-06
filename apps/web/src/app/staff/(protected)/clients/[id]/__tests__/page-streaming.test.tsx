// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Review-Befunde P-07 und K-04: Kopf, Navigation und Kopfdaten-Karten des
// Cockpits rendern, ohne auf die Blockdaten zu warten; die übrigen Karten
// zeigen bis dahin Platzhalter in eigenen <Suspense>-Grenzen und warten je
// nur auf das Promise ihres eigenen Loaders.

import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIENT_LAYOUT } from '@/server/settings/client-layout-shared';

const h = vi.hoisted(() => ({
  session: {
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['EMPLOYEE'], permissions: [] },
  },
  modules: {} as Record<string, unknown>,
  header: null as unknown,
  loadHeader: vi.fn(),
  blocks: vi.fn(),
  withTenantContext: vi.fn(async () => {
    throw new Error('Die Cockpit-Seite darf keine eigene Tenant-Transaktion öffnen.');
  }),
  riskAvailable: vi.fn(async () => true),
  isAdmin: false,
  quickRequest: vi.fn((_props: unknown) => null),
}));

vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@taxtronik/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/db')>()),
  withTenantContext: h.withTenantContext,
}));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/auth/client-page-access', () => ({
  requireClientPageAccess: vi.fn(async () => h.session),
}));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: () => h.isAdmin }));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn(async () => h.modules) }));
vi.mock('@/server/settings/client-layout', () => ({
  readClientLayout: vi.fn(async () => DEFAULT_CLIENT_LAYOUT),
}));
vi.mock('@/server/risk/availability', () => ({ isRiskLayerAvailable: h.riskAvailable }));
vi.mock('@taxtronik/elster', () => ({ isElsterConfigured: () => false }));
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: h.quickRequest }));
vi.mock('@/components/recent-clients', () => ({ RecordClientVisit: () => null }));
vi.mock('@/components/client-contacts-panel', () => ({
  ClientContactsPanel: ({ contacts }: { contacts: unknown[] }) => (
    <section>Ansprechpartner ({contacts.length})</section>
  ),
}));
vi.mock('../_data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_data')>()),
  loadClientCockpitHeader: h.loadHeader,
  startClientCockpitBlocks: h.blocks,
  loadClientDocumentsPage: vi.fn(() => new Promise(() => {})),
}));
// Die echten Blöcke, nur mitgeschnitten: Welche Daten bekommt welcher Block?
vi.mock('../cockpit-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cockpit-blocks')>();
  return {
    ...actual,
    UpcomingCockpitBlock: vi.fn(actual.UpcomingCockpitBlock),
    WorkflowsCockpitBlock: vi.fn(actual.WorkflowsCockpitBlock),
    RemindersCockpitBlock: vi.fn(actual.RemindersCockpitBlock),
    BindersCockpitBlock: vi.fn(actual.BindersCockpitBlock),
    HandoversCockpitBlock: vi.fn(actual.HandoversCockpitBlock),
    PhoneNotesCockpitBlock: vi.fn(actual.PhoneNotesCockpitBlock),
    RequestsCockpitBlock: vi.fn(actual.RequestsCockpitBlock),
  };
});
// Client-Komponenten der Blöcke brauchen den App-Router nicht für diesen Test.
vi.mock('../reminders/reminders-block', () => ({
  RemindersBlock: ({ initial }: { initial: unknown[] }) => <p>Wiedervorlagen: {initial.length}</p>,
}));

import ClientDetailPage from '../page';
import {
  BindersCockpitBlock,
  HandoversCockpitBlock,
  PhoneNotesCockpitBlock,
  RemindersCockpitBlock,
  RequestsCockpitBlock,
  UpcomingCockpitBlock,
  WorkflowsCockpitBlock,
} from '../cockpit-blocks';

/** Ein eigenes, noch offenes Promise je gestreamtem Block. */
function pendingLoads() {
  const pending = () => new Promise<never>(() => {});
  return {
    requests: pending(),
    upcoming: pending(),
    workflows: pending(),
    reminders: pending(),
    phoneNotes: pending(),
    binders: pending(),
    handovers: pending(),
  };
}

/** Props des ersten Aufrufs einer mitgeschnittenen Blockkomponente. */
function propsOf(block: unknown): Record<string, unknown> {
  return vi.mocked(block as (props: Record<string, unknown>) => unknown).mock.calls[0]![0];
}

const ALL_MODULES = {
  taxNotices: true,
  appointments: true,
  workflows: true,
  reminders: true,
  binders: true,
  handovers: true,
  phoneNotes: true,
  timeTracking: false,
  bwa: false,
  poaMode: 'OFF',
  risk: true,
  forms: false,
};

function headerData(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    data: {
      client: {
        id: 'client-1',
        name: 'Muster GmbH',
        kind: 'JURPERS',
        datevNo: '10001',
        addisonNo: null,
        allowActive: true,
        onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        contacts: [{ id: 'c1', fullName: 'Erika', email: 'e@example.test', phone: null }],
        gwgChecks: [],
        responsibilities: [],
        _count: { poas: 0, gwgInvites: 0, gwgChecks: 1, requests: 4 },
      },
      pendingChangeRequests: 2,
      customDefs: [{ id: 'f1', label: 'Branche', type: 'TEXT', appliesTo: [] }],
      customValues: [{ fieldId: 'f1', value: 'Handel' }],
      requestTemplates: [],
      requestFormTemplates: [],
      templatesLimited: false,
      formTemplatesLimited: false,
      ...overrides,
    },
  };
}

async function render() {
  return renderToStaticMarkup(
    await ClientDetailPage({
      params: Promise.resolve({ id: 'client-1' }),
      searchParams: Promise.resolve({}),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modules = { ...ALL_MODULES };
  h.header = headerData();
  h.isAdmin = false;
  h.loadHeader.mockImplementation(async () => h.header);
  h.blocks.mockImplementation(() => pendingLoads());
});

describe('Mandanten-Cockpit streamt die Blöcke', () => {
  it('rendert Kopf, Navigation und Kopfdaten-Karten, während die Blockdaten noch laden', async () => {
    const html = await render();

    expect(html).toContain('Muster GmbH');
    expect(html).toContain('Stammdaten-Änderungen');
    expect(html).toContain('<span class="badge-yellow ml-2">2</span>');
    expect(html).toContain('Ansprechpartner (1)');
    expect(html).toContain('Branche');
    expect(html).toContain('GwG-Status');
    for (const title of [
      'Anstehende Termine',
      'Aktive Workflows',
      'Wiedervorlagen',
      'Pendelordner',
      'Anlieferungen',
      'Telefonzettel',
      'Anforderungen',
    ]) {
      expect(html).toContain(`aria-label="${title} wird geladen"`);
    }
    expect(html).toContain('aria-label="Dokumente werden geladen"');
    // Blockdaten laufen in EINER zusätzlichen Transaktion mit den Modulen der Seite.
    expect(h.blocks).toHaveBeenCalledTimes(1);
    expect(h.blocks.mock.calls[0]![3]).toBe(h.modules);
    // Die Seite selbst lädt nur über die Loader und öffnet keine eigene Transaktion.
    expect(h.loadHeader).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      h.session,
      'client-1',
    );
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('gibt jedem gestreamten Block das Promise seines eigenen Loaders', async () => {
    await render();

    const loads = h.blocks.mock.results[0]!.value as ReturnType<typeof pendingLoads>;
    expect(propsOf(RequestsCockpitBlock).data).toBe(loads.requests);
    expect(propsOf(UpcomingCockpitBlock).data).toBe(loads.upcoming);
    expect(propsOf(WorkflowsCockpitBlock).data).toBe(loads.workflows);
    expect(propsOf(RemindersCockpitBlock).data).toBe(loads.reminders);
    expect(propsOf(PhoneNotesCockpitBlock).data).toBe(loads.phoneNotes);
    expect(propsOf(BindersCockpitBlock).data).toBe(loads.binders);
    expect(propsOf(HandoversCockpitBlock).data).toBe(loads.handovers);
    expect(propsOf(RemindersCockpitBlock)).toMatchObject({
      clientId: 'client-1',
      staffId: 'staff-1',
      isAdmin: false,
    });
    expect(propsOf(PhoneNotesCockpitBlock).contacts).toEqual([{ fullName: 'Erika', phone: null }]);
    expect(propsOf(UpcomingCockpitBlock)).toMatchObject({ showTax: true, showAppts: true });
  });

  it('reicht Mandant und Vorlagen an den Anforderungsdialog im Kopf weiter', async () => {
    await render();

    expect(h.quickRequest).toHaveBeenCalledTimes(1);
    expect(h.quickRequest.mock.calls[0]![0]).toMatchObject({
      client: {
        id: 'client-1',
        name: 'Muster GmbH',
        datevNo: '10001',
        addisonNo: null,
        allowActive: true,
      },
      templates: [],
      formTemplates: [],
      templatesLimited: false,
      formTemplatesLimited: false,
    });
  });

  it('zeigt Reiter aus der Modul-Registry samt Zählern', async () => {
    h.modules = { ...ALL_MODULES, poaMode: 'MARKDOWN_OTP' };
    h.header = headerData();
    (h.header as { data: { client: { _count: { poas: number } } } }).data.client._count.poas = 3;

    const html = await render();

    expect(html).toContain('href="/staff/poa?clientId=client-1"');
    expect(html).toContain('<span class="badge-gray ml-2">3</span>');
    expect(html).toContain('href="/staff/clients/client-1/change-requests"');
  });

  it('startet die Blockdaten, bevor der Kopf geladen ist', async () => {
    let resolveHeader: ((value: unknown) => void) | undefined;
    h.loadHeader.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHeader = resolve;
        }),
    );

    const pending = render();
    await vi.waitFor(() => expect(resolveHeader).toBeDefined());
    expect(h.blocks).toHaveBeenCalledTimes(1);

    resolveHeader!(h.header);
    expect(await pending).toContain('Muster GmbH');
  });

  it('zeigt keine Platzhalter für abgeschaltete Module', async () => {
    h.modules = {
      ...ALL_MODULES,
      taxNotices: false,
      appointments: false,
      workflows: false,
      reminders: false,
      binders: false,
      handovers: false,
      phoneNotes: false,
    };

    const html = await render();

    expect(html).toContain('aria-label="Anforderungen wird geladen"');
    expect(html).not.toContain('aria-label="Wiedervorlagen wird geladen"');
    expect(html).not.toContain('aria-label="Anstehende Termine wird geladen"');
  });

  it('fragt die Signal-Engine nur, wenn die Subsumtions-Pill überhaupt erscheinen darf', async () => {
    await render();
    expect(h.riskAvailable).not.toHaveBeenCalled();

    h.isAdmin = true;
    await render();
    expect(h.riskAvailable).toHaveBeenCalledTimes(1);

    h.riskAvailable.mockClear();
    h.modules = { ...ALL_MODULES, risk: false };
    await render();
    expect(h.riskAvailable).not.toHaveBeenCalled();
  });

  it('leitet bei verweigertem oder fehlendem Mandanten um, bevor Blöcke rendern', async () => {
    h.header = { status: 'forbidden' };
    await expect(render()).rejects.toThrow('redirect:/staff/clients?denied=1');
    h.header = { status: 'not_found' };
    await expect(render()).rejects.toThrow('notFound');
  });
});

describe('gestreamte Cockpit-Blöcke', () => {
  const requests = [
    {
      id: 'r1',
      title: 'Belege 2025',
      status: 'OPEN',
      priority: 'URGENT',
      dueAt: new Date('2026-11-01T00:00:00.000Z'),
      responses: [{ createdAt: new Date('2026-10-01T00:00:00.000Z') }],
    },
  ];

  async function renderBlock(node: Promise<ReactNode>) {
    return renderToStaticMarkup(<>{await node}</>);
  }

  it('rendert die Anforderungen aus den Blockdaten', async () => {
    const html = await renderBlock(
      RequestsCockpitBlock({
        data: Promise.resolve(requests as never),
        client: { id: 'client-1', name: 'Muster & Söhne' },
      }),
    );
    expect(html).toContain('href="/staff/requests/r1"');
    expect(html).toContain('<span class="badge-yellow">Offen</span>');
    expect(html).toContain('<span class="badge-red">Dringend</span>');
    expect(html).toContain(
      `href="/staff/requests?q=${encodeURIComponent('Muster & Söhne').replace('&', '&amp;')}"`,
    );
  });

  it('rendert nichts, wenn der Zugriffs-Backstop der Blocktransaktion greift', async () => {
    expect(
      await renderBlock(
        RequestsCockpitBlock({ data: Promise.resolve(null), client: { id: 'c', name: 'x' } }),
      ),
    ).toBe('');
    expect(
      await renderBlock(
        WorkflowsCockpitBlock({ data: Promise.resolve(null), clientId: 'c', now: new Date() }),
      ),
    ).toBe('');
    expect(
      await renderBlock(BindersCockpitBlock({ data: Promise.resolve(null), clientId: 'c' })),
    ).toBe('');
  });

  it('rendert Steuertermine und Termine aus den Daten des eigenen Loaders', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const html = await renderBlock(
      UpcomingCockpitBlock({
        data: Promise.resolve({
          taxDeadlines: [
            {
              id: 'd1',
              kind: 'USTA_MONATLICH',
              period: '2026-09',
              dueDate: new Date('2026-10-10T00:00:00.000Z'),
              status: 'PLANNED',
            },
          ],
          upcomingAppointments: [],
          pendingAppointmentRequests: [],
          staffList: [],
        } as never),
        client: { id: 'client-1', name: 'Muster GmbH' },
        showTax: true,
        showAppts: true,
        staffId: 'staff-1',
        now,
      }),
    );
    expect(html).toContain('USt-Voranmeldung (monatlich)');
    expect(html).toContain('<span class="badge-purple text-[10px]">Steuertermin</span>');
    expect(html).toContain('2026-09');
    expect(html).toContain('noch 9 Tage');
  });
});
