// Fachkatalog: ACCESS-SEARCH-SCOPE-001
// Review-Befund P-07: Kopf, Navigation und Kopfdaten-Karten des Cockpits
// rendern, ohne auf die Blockdaten zu warten; die übrigen Karten zeigen bis
// dahin Platzhalter in eigenen <Suspense>-Grenzen.

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
  blocks: vi.fn(),
  riskAvailable: vi.fn(async () => true),
  isAdmin: false,
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
vi.mock('@/components/quick-request-dialog', () => ({ QuickRequestDialog: () => null }));
vi.mock('@/components/recent-clients', () => ({ RecordClientVisit: () => null }));
vi.mock('@/components/client-contacts-panel', () => ({
  ClientContactsPanel: ({ contacts }: { contacts: unknown[] }) => (
    <section>Ansprechpartner ({contacts.length})</section>
  ),
}));
vi.mock('../_data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_data')>()),
  loadClientCockpitHeader: vi.fn(async () => h.header),
  loadClientCockpitBlocks: h.blocks,
  loadClientDocumentsPage: vi.fn(() => new Promise(() => {})),
}));
// Client-Komponenten der Blöcke brauchen den App-Router nicht für diesen Test.
vi.mock('../reminders/reminders-block', () => ({
  RemindersBlock: ({ initial }: { initial: unknown[] }) => <p>Wiedervorlagen: {initial.length}</p>,
}));

import ClientDetailPage from '../page';
import { RequestsCockpitBlock, WorkflowsCockpitBlock } from '../cockpit-blocks';

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
  h.blocks.mockReturnValue(new Promise(() => {}));
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
        blocks: Promise.resolve({ requests } as never),
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
        RequestsCockpitBlock({ blocks: Promise.resolve(null), client: { id: 'c', name: 'x' } }),
      ),
    ).toBe('');
    expect(
      await renderBlock(
        WorkflowsCockpitBlock({ blocks: Promise.resolve(null), clientId: 'c', now: new Date() }),
      ),
    ).toBe('');
  });
});
