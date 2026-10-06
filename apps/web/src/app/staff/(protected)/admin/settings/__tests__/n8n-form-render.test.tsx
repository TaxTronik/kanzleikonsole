// n8n-Adminformular: gerenderte Stufen, Sektionen und Zustände statt
// Quelltextprüfung. Klick-Verdrahtung (Action-Argumente, Refresh) braucht eine
// DOM-Testumgebung und ist hier nicht abgedeckt.

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nSetupStatus } from '@/server/n8n/status';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../n8n-actions', () => ({
  acknowledgeN8nDeliveryAction: vi.fn(),
  deleteN8nEndpointAction: vi.fn(),
  discoverN8nWebhooksAction: vi.fn(),
  generateSigningSecretAction: vi.fn(),
  importWorkflowsAction: vi.fn(),
  listFailedN8nDeliveriesAction: vi.fn(),
  listWorkflowsAction: vi.fn(),
  replayUnroutedN8nEventAction: vi.fn(),
  resetN8nAction: vi.fn(),
  retryN8nDeliveryAction: vi.fn(),
  rotateN8nCallbackCredentialAction: vi.fn(),
  saveN8nAction: vi.fn(),
  saveN8nEndpointAction: vi.fn(),
  skipUnroutedN8nEventAction: vi.fn(),
  testN8nApiAction: vi.fn(),
  testN8nEndpointAction: vi.fn(),
}));
// Radix-Menü und Portal-Modal rendern serverseitig nichts; die Doubles machen
// Menüeinträge und Editorinhalt für den statischen Render sichtbar.
vi.mock('@/components/overflow-menu', () => ({
  OverflowMenu: ({ children }: { children: ReactNode }) => <div data-overflow="">{children}</div>,
  OverflowItem: ({ children }: { children: ReactNode }) => (
    <button type="button" data-overflow-item="">
      {children}
    </button>
  ),
  OverflowSeparator: () => <hr />,
}));
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) => (
    <div role="dialog" aria-label={title}>
      {children}
    </div>
  ),
  confirmDialog: vi.fn(),
}));

import { N8nForm, discoveredRouteDraft } from '../n8n-form';
import { N8nConnectionSection } from '../n8n-connection-section';
import { EMPTY_ROUTE, RouteEditorSection, type RouteDraft } from '../route-editor-section';
import { N8nWorkflowsSection } from '../n8n-workflows-section';
import { createN8nConnectionState } from '../n8n-connection-state';
import type { BundledWorkflowSummary, N8nBrowserConfig } from '../n8n-form-types';

const STAGE_TITLES = [
  'n8n-Instanz verbinden',
  'Rückkanal n8n → TaxTronik',
  'Workflows einrichten',
  'Routen — Events an Workflows',
  'Betrieb — Zustellung &amp; Diagnose',
];

function config(overrides: Partial<N8nBrowserConfig> = {}): N8nBrowserConfig {
  return {
    connectionId: 'connection-1',
    name: 'Kanzlei n8n',
    kind: 'SELF_HOSTED',
    routingMode: 'EXPLICIT',
    enabled: true,
    uiBaseUrl: 'https://n8n.kanzlei.example',
    callbackBaseUrl: 'https://app.kanzlei.example',
    webhookBaseUrl: 'https://n8n.kanzlei.example/webhook',
    apiBaseUrl: 'https://n8n.kanzlei.example/api/v1',
    hasSigningSecret: true,
    hasApiKey: true,
    callbackKeyId: 'key-1',
    callbackConfigured: false,
    callbackScopes: [],
    healthCheckedAt: null,
    healthOk: null,
    healthError: null,
    source: 'CONNECTION',
    ...overrides,
  };
}

function endpoint(overrides: Partial<N8nEndpointView> = {}): N8nEndpointView {
  return {
    id: 'endpoint-1',
    name: 'Mandant angelegt',
    productionUrl: 'https://n8n.kanzlei.example/webhook/client-created',
    testUrl: 'https://n8n.kanzlei.example/webhook-test/client-created',
    workflowId: 'wf-1',
    workflowName: 'TaxTronik Mandanten',
    workflowNodeId: 'node-1',
    source: 'MANAGED',
    enabled: true,
    testMode: false,
    verifiedAt: '2026-10-01T08:00:00.000Z',
    verificationOk: true,
    verificationError: null,
    events: ['client.created', 'taxtronik.ping'],
    ...overrides,
  };
}

function setupStatus(overrides: Partial<N8nSetupStatus> = {}): N8nSetupStatus {
  return {
    connectionId: 'connection-1',
    enabled: true,
    routingMode: 'EXPLICIT',
    callbackConfigured: false,
    endpointCount: 1,
    activeEndpointCount: 1,
    subscriptionCount: 2,
    deliveryCounts: { pending: 0, delivered: 4, failed: 1, skipped: 0, unrouted: 1 },
    unroutedEvents: [{ event: 'request.opened', count: 1 }],
    recentUnroutedEvents: [
      {
        id: 'outbox-1',
        event: 'request.opened',
        occurredAt: '2026-10-02T09:00:00.000Z',
        lastError: null,
      },
    ],
    endpoints: [endpoint()],
    failedDeliveries: [
      {
        id: 'delivery-1',
        eventId: 'outbox-2',
        event: 'client.created',
        endpoint: 'Mandant angelegt',
        targetUrl: 'https://n8n.kanzlei.example/webhook/client-created',
        status: 'FAILED',
        attempts: 3,
        httpStatus: 500,
        latencyMs: 120,
        lastError: 'HTTP 500',
        createdAt: '2026-10-02T09:00:00.000Z',
        deliveredAt: null,
      },
    ],
    hasMoreFailedDeliveries: false,
    recentDeliveries: [],
    ...overrides,
  };
}

const BUNDLED: BundledWorkflowSummary[] = [
  {
    templateId: 'taxtronik.client-created',
    version: 1,
    name: 'TaxTronik Mandanten',
    description: 'Benachrichtigt bei neuen Mandanten.',
    events: ['client.created'],
    callbackScopes: [],
    credentials: [],
    prerequisites: [],
  },
];

function renderForm(initial = config(), status = setupStatus()) {
  return renderToStaticMarkup(
    <N8nForm
      initial={initial}
      status={status}
      events={N8N_EVENT_CATALOG}
      bundledWorkflows={BUNDLED}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Öffnendes Tag des Buttons, dessen Inhalt `label` enthält. */
function buttonTag(html: string, label: string): string {
  const before = html.slice(0, html.indexOf(label));
  const start = before.lastIndexOf('<button');
  return html.slice(start, html.indexOf('>', start) + 1);
}

function routeEditor(overrides: {
  endpoints?: N8nEndpointView[];
  connectionActive?: boolean;
  routeDraft?: RouteDraft;
}) {
  return renderToStaticMarkup(
    <RouteEditorSection
      endpoints={overrides.endpoints ?? []}
      connectionActive={overrides.connectionActive ?? true}
      events={N8N_EVENT_CATALOG}
      routeDraft={overrides.routeDraft ?? EMPTY_ROUTE}
      setRouteDraft={vi.fn()}
      customEvent=""
      setCustomEvent={vi.fn()}
      routeResult={null}
      testResult={{}}
      busy={false}
      saving={false}
      onSaveRoute={vi.fn()}
      onEditRoute={vi.fn()}
      onDeleteRoute={vi.fn()}
      onTestRoute={vi.fn()}
      onToggleRoute={vi.fn()}
    />,
  );
}

describe('n8n-Adminformular — geführte Stufen', () => {
  it('rahmt die fünf Sektionen als Stufen und zeigt jeden Titel genau einmal', () => {
    const html = renderForm();

    for (const title of STAGE_TITLES) {
      expect(count(html, `<div class="stage-title">${title}</div>`), title).toBe(1);
      expect(count(html, title), title).toBe(1);
    }
    expect(count(html, 'class="card stage ')).toBe(5);
  });

  it('bildet die Stufen 1:1 im Stepper ab und markiert genau eine als aktiv', () => {
    const html = renderForm(config({ hasSigningSecret: false, callbackConfigured: false }));

    const labels = [...html.matchAll(/<span class="step-title">([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(['Verbinden', 'Rückkanal', 'Workflows', 'Routen', 'Betrieb']);
    expect(count(html, '<li class="step active">')).toBe(1);
    // Verbunden, aber noch ohne Rückkanal: die zweite Stufe ist die aktive.
    expect(html).toMatch(
      /<li class="step done">(?:(?!<li).)*Verbinden(?:(?!<li).)*<\/li><li class="step active">(?:(?!<li).)*Rückkanal/s,
    );
  });

  it('zeigt Zustellbetrieb mit Aktionen für Fehler und Events ohne Route', () => {
    const html = renderForm();

    expect(html).toContain('1 offene fehlgeschlagene Zustellung(en)');
    expect(html).toContain('Erneut versuchen');
    expect(html).toContain('Quittieren');
    expect(html).toContain('Jetzt zuordnen');
    expect(html).toContain('Nicht senden');
    expect(html).toContain('Integration deaktivieren und bereinigen');
  });

  it('erklärt den Rückkanal als eigenes Bearer-Credential', () => {
    const html = renderForm();

    expect(html).toContain('Die Key-ID allein ist kein Credential.');
    expect(html).toContain('Bearer &lt;Key-ID&gt;.&lt;Callback-Token&gt;');
  });
});

describe('n8n-Verbindung', () => {
  it('weist bei der verwalteten Instanz ohne API-Key auf den einmaligen Schritt hin', () => {
    const managed = renderForm(config({ kind: 'BUNDLED', hasApiKey: false }));
    expect(managed).toContain('Die verwaltete n8n-Instanz ist bereits verbunden.');

    expect(renderForm()).not.toContain('Die verwaltete n8n-Instanz ist bereits verbunden.');
    expect(renderForm(config({ kind: 'BUNDLED' }))).not.toContain(
      'Die verwaltete n8n-Instanz ist bereits verbunden.',
    );
  });

  function connectionSection(initial: N8nBrowserConfig, patch: Record<string, unknown> = {}) {
    return renderToStaticMarkup(
      <N8nConnectionSection
        initial={initial}
        connection={{ ...createN8nConnectionState(initial), ...patch }}
        dispatchConnection={vi.fn()}
        saveAction={vi.fn()}
        saving={false}
        busy={false}
        apiInstanceChanged={false}
        generateSecret={vi.fn()}
        testApi={vi.fn()}
        saveState={null}
        apiResult={null}
        copied={null}
        copy={vi.fn()}
      />,
    );
  }

  it('zeigt den Status des HMAC-Secrets statt seines Werts', () => {
    expect(connectionSection(config())).toContain(
      'Ein aktuelles HMAC-Signatur-Secret ist gespeichert.',
    );

    const generated = connectionSection(config(), { hmacSecret: 'secret-value', keepHmac: false });
    expect(generated).toContain('Neues HMAC-Secret erzeugt, noch nicht gespeichert.');
    expect(generated).not.toContain('Ein aktuelles HMAC-Signatur-Secret ist gespeichert.');
  });

  it('erlaubt den API-Test nur mit API-Adresse und Schlüssel', () => {
    expect(buttonTag(connectionSection(config()), 'API testen')).not.toContain('disabled');
    expect(buttonTag(connectionSection(config({ hasApiKey: false })), 'API testen')).toContain(
      'disabled=""',
    );
    expect(buttonTag(connectionSection(config({ apiBaseUrl: '' })), 'API testen')).toContain(
      'disabled=""',
    );
  });
});

describe('n8n-Routen', () => {
  it('bündelt Routenaktionen im Overflow-Menü der Routenkarte', () => {
    const html = routeEditor({ endpoints: [endpoint()] });
    const menu = html.slice(html.indexOf('data-overflow=""'));

    expect(html).toContain('Bearbeiten');
    expect(menu).toContain('Deaktivieren');
    expect(menu).toContain('Produktion testen');
    expect(menu).toContain('Test: client.created');
    expect(menu).toContain('Route löschen');
  });

  it('bietet je nach Zustand Aktivieren oder Integration aktivieren an', () => {
    expect(routeEditor({ endpoints: [endpoint({ enabled: false })] })).toContain('Aktivieren');
    const inactiveConnection = routeEditor({ endpoints: [endpoint()], connectionActive: false });
    expect(inactiveConnection).toContain('Integration aktivieren');
    expect(inactiveConnection.slice(inactiveConnection.indexOf('data-overflow=""'))).not.toContain(
      'Deaktivieren',
    );
  });

  it('öffnet für einen vorbefüllten Entwurf den eigenständigen Editor', () => {
    expect(routeEditor({})).not.toContain('id="n8n-route-editor"');

    const html = routeEditor({
      routeDraft: { ...EMPTY_ROUTE, id: 'endpoint-1', name: 'Mandant angelegt' },
    });
    expect(html).toContain('aria-label="Route bearbeiten"');
    expect(html).toMatch(/<form id="n8n-route-editor" data-settings-no-track="true"/);
    expect(buttonTag(html, 'Verwerfen')).toContain('type="button"');
    expect(buttonTag(html, 'Speichern</button>')).toContain('type="submit"');
  });
});

describe('n8n-Workflows — erkannte Webhooks', () => {
  const discovered = {
    workflowId: 'wf-9',
    workflowName: 'TaxTronik Mandanten',
    workflowActive: true,
    nodeId: 'node-9',
    nodeName: 'Webhook',
    path: 'client.created',
    productionUrl: 'https://n8n.kanzlei.example/webhook/client.created',
    testUrl: 'https://n8n.kanzlei.example/webhook-test/client.created',
  };

  function workflows(selectedKey: string | null, canSave: boolean) {
    return renderToStaticMarkup(
      <N8nWorkflowsSection
        initial={config()}
        bundledWorkflows={BUNDLED}
        selectedTemplates={[]}
        setSelectedTemplates={vi.fn()}
        n8nMailFrom=""
        setN8nMailFrom={vi.fn()}
        gwgOfficerEmail=""
        setGwgOfficerEmail={vi.fn()}
        workflows={null}
        workflowError={null}
        discovered={[discovered]}
        discoveryError={null}
        importResult={null}
        importWorkflows={vi.fn()}
        loadWorkflows={vi.fn()}
        discoverWebhooks={vi.fn()}
        selectDiscovered={vi.fn()}
        selectedDiscoveredKey={selectedKey}
        selectedDiscoveredCanSave={canSave}
        saveSelectedDiscovered={vi.fn()}
        routeResult={null}
        busy={false}
        saving={false}
      />,
    );
  }

  it('macht eine übernommene Route direkt an ihrer Fundstelle speicherbar', () => {
    const unselected = workflows(null, false);
    expect(unselected).toContain('Als Route übernehmen');
    expect(unselected).not.toContain('Route speichern');

    const selected = workflows('wf-9:node-9', true);
    expect(selected).toContain('Das zum Workflow gehörende Event ist vorausgewählt.');
    expect(buttonTag(selected, 'Route speichern')).not.toContain('disabled');

    const withoutEvent = workflows('wf-9:node-9', false);
    expect(withoutEvent).toContain('mindestens ein Event auswählen');
    expect(buttonTag(withoutEvent, 'Route speichern')).toContain('disabled=""');
  });

  it('wählt für verwaltete Workflows deren Events samt Webhook-Pfad vor', () => {
    const managed = discoveredRouteDraft(
      { ...discovered, path: 'taxtronik.ping' },
      [{ ...BUNDLED[0]!, events: ['client.created', 'not.in.catalog'] }],
      N8N_EVENT_CATALOG,
    );
    expect(managed).toMatchObject({
      source: 'MANAGED',
      enabled: true,
      workflowId: 'wf-9',
      workflowNodeId: 'node-9',
      events: ['client.created', 'taxtronik.ping'],
    });

    const foreign = discoveredRouteDraft(
      {
        ...discovered,
        workflowName: 'Eigener Workflow',
        workflowActive: false,
        path: 'kein-event',
      },
      BUNDLED,
      N8N_EVENT_CATALOG,
    );
    expect(foreign).toMatchObject({ source: 'DISCOVERED', enabled: false, events: [] });

    const long = discoveredRouteDraft(
      { ...discovered, workflowName: 'W'.repeat(200) },
      [],
      N8N_EVENT_CATALOG,
    );
    expect(long.name).toHaveLength(120);
  });
});
