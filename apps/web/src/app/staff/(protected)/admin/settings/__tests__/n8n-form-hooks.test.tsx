// n8n-Adminformular: Verdrahtung der Bereichs-Hooks mit Server-Actions,
// gemeinsamer Transition, Bestätigung und Router-Refresh. Der statische Render
// liefert die Handler des Anfangszustands; Zustandswechsel prüft
// n8n-form-state.test.ts an den reinen Reducern.

import type { FormEvent, TransitionStartFunction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nSetupStatus } from '@/server/n8n/status';

const actions = vi.hoisted(() => ({
  acknowledgeN8nDeliveryAction: vi.fn(),
  deleteN8nEndpointAction: vi.fn(),
  discoverN8nWebhooksAction: vi.fn(),
  importWorkflowsAction: vi.fn(),
  listFailedN8nDeliveriesAction: vi.fn(),
  listWorkflowsAction: vi.fn(),
  replayUnroutedN8nEventAction: vi.fn(),
  retryN8nDeliveryAction: vi.fn(),
  rotateN8nCallbackCredentialAction: vi.fn(),
  saveN8nEndpointAction: vi.fn(),
  skipUnroutedN8nEventAction: vi.fn(),
  testN8nEndpointAction: vi.fn(),
}));
vi.mock('../n8n-actions', () => actions);
const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock('@/components/ui/modal', () => ({ confirmDialog }));

import {
  useN8nCallbackCredentials,
  useN8nDeliveryOperations,
  useN8nRoutes,
  useN8nWorkflowSetup,
  type N8nFormRuntime,
} from '../n8n-form-hooks';
import { EMPTY_ROUTE, routeDraftFormData, routeToggleFormData } from '../n8n-form-state';
import type { BundledWorkflowSummary, N8nBrowserConfig } from '../n8n-form-types';

let log: string[] = [];
let pending: Promise<unknown>[] = [];

function runtime(): N8nFormRuntime {
  const startTransition = vi.fn((callback: () => unknown) => {
    log.push('transition');
    pending.push(Promise.resolve(callback()));
  }) as unknown as TransitionStartFunction;
  return { startTransition, router: { refresh: () => log.push('refresh') } };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.all(pending);
}

/** Rendert den Hook statisch und liefert seine Handler des Anfangszustands. */
function probe<T>(useHook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return value!;
}

function respond(name: keyof typeof actions, result: unknown) {
  actions[name].mockImplementation(async (...args: unknown[]) => {
    log.push(`${name}:${JSON.stringify(args.map(entries))}`);
    return result;
  });
}

function entries(value: unknown) {
  return value instanceof FormData ? [...value.entries()] : value;
}

const BUNDLED: BundledWorkflowSummary[] = [
  {
    templateId: 'taxtronik.client-created',
    version: 1,
    name: 'TaxTronik Mandanten',
    description: 'Mandanten.',
    events: ['client.created'],
    callbackScopes: ['clients:read'],
    credentials: [],
    prerequisites: [],
  },
  {
    templateId: 'taxtronik.requests',
    version: 1,
    name: 'TaxTronik Anforderungen',
    description: 'Anforderungen.',
    events: ['request.opened'],
    callbackScopes: ['requests:write', 'clients:read'],
    credentials: [],
    prerequisites: [],
  },
];

const ENDPOINT: N8nEndpointView = {
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
  verifiedAt: null,
  verificationOk: null,
  verificationError: null,
  events: ['client.created'],
};

beforeEach(() => {
  vi.resetAllMocks();
  log = [];
  pending = [];
  confirmDialog.mockImplementation(async (message: string) => {
    log.push(`confirm:${message}`);
    return true;
  });
});

describe('Rückkanal-Hook', () => {
  it('erzeugt das erste Token ohne Bestätigung mit den Vorlagen-Scopes', async () => {
    respond('rotateN8nCallbackCredentialAction', { ok: true, message: 'Erzeugt.' });
    const initial = {
      callbackScopes: [],
      callbackConfigured: false,
    } as unknown as N8nBrowserConfig;
    const hook = probe(() => useN8nCallbackCredentials(initial, BUNDLED, runtime()));
    expect(hook).toMatchObject({
      callbackScopes: ['clients:read', 'requests:write'],
      callbackConfigured: false,
      callbackResult: null,
    });
    hook.rotateCallback();
    await settle();
    expect(log).toEqual([
      'transition',
      'rotateN8nCallbackCredentialAction:[["clients:read","requests:write"]]',
      'refresh',
    ]);
  });

  it('bestätigt die Rotation eines eingerichteten Tokens und lädt nur bei Erfolg neu', async () => {
    respond('rotateN8nCallbackCredentialAction', { ok: false, error: 'Nein.' });
    const initial = {
      callbackScopes: ['gwg:read'],
      callbackConfigured: true,
    } as unknown as N8nBrowserConfig;
    const hook = probe(() => useN8nCallbackCredentials(initial, BUNDLED, runtime()));
    hook.rotateCallback();
    await settle();
    expect(log).toEqual([
      'confirm:Das bisherige Callback-Token wird sofort ungültig. Wirklich rotieren?',
      'transition',
      'rotateN8nCallbackCredentialAction:[["gwg:read"]]',
    ]);
  });
});

describe('Workflow-Hook', () => {
  it('importiert, meldet das Ergebnis, lädt die Workflow-Liste und aktualisiert', async () => {
    const result = { ok: true, message: 'Importiert.', callbackConfigured: true };
    respond('importWorkflowsAction', result);
    respond('listWorkflowsAction', { ok: false });
    const onImported = vi.fn((value: unknown) => log.push(`imported:${value === result}`));
    const hook = probe(() => useN8nWorkflowSetup(BUNDLED, runtime(), onImported));
    hook.importWorkflows();
    await settle();
    expect(log).toEqual([
      'transition',
      'importWorkflowsAction:[{"templateIds":["taxtronik.client-created","taxtronik.requests"],"smtpFrom":"","gwgOfficerEmail":""}]',
      'imported:true',
      'listWorkflowsAction:[]',
      'refresh',
    ]);
  });

  it('lädt Workflow-Status und Webhooks ohne Router-Refresh', async () => {
    respond('listWorkflowsAction', { ok: true, workflows: [] });
    respond('discoverN8nWebhooksAction', { ok: true, webhooks: [] });
    const hook = probe(() => useN8nWorkflowSetup(BUNDLED, runtime(), vi.fn()));
    hook.loadWorkflows();
    hook.discoverWebhooks();
    await settle();
    expect(log).toEqual([
      'transition',
      'listWorkflowsAction:[]',
      'transition',
      'discoverN8nWebhooksAction:[]',
    ]);
  });
});

describe('Routen-Hook', () => {
  function routes(dispatchConnection = vi.fn()) {
    return probe(() =>
      useN8nRoutes(
        { bundledWorkflows: BUNDLED, events: N8N_EVENT_CATALOG, dispatchConnection },
        runtime(),
      ),
    );
  }

  it('speichert den Entwurf per Formular und übernimmt eine Aktivierung', async () => {
    respond('saveN8nEndpointAction', { ok: true, connectionActivated: true });
    const dispatchConnection = vi.fn();
    const hook = routes(dispatchConnection);
    const preventDefault = vi.fn();
    hook.saveRoute({ preventDefault } as unknown as FormEvent<HTMLFormElement>);
    await settle();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(log).toEqual([
      'transition',
      `saveN8nEndpointAction:${JSON.stringify([null, [...routeDraftFormData(EMPTY_ROUTE, '').entries()]])}`,
      'refresh',
    ]);
    expect(dispatchConnection).toHaveBeenCalledWith({
      type: 'patch',
      value: { enabled: true, routingMode: 'EXPLICIT' },
    });
  });

  it('lädt nach fehlgeschlagenem Speichern oder Schalten nicht neu', async () => {
    respond('saveN8nEndpointAction', { ok: false, error: 'Ungültig.' });
    const dispatchConnection = vi.fn();
    const hook = routes(dispatchConnection);
    hook.persistRouteDraft();
    hook.toggleRoute(ENDPOINT, { enabled: false });
    await settle();
    expect(log).toEqual([
      'transition',
      `saveN8nEndpointAction:${JSON.stringify([null, [...routeDraftFormData(EMPTY_ROUTE, '').entries()]])}`,
      'transition',
      `saveN8nEndpointAction:${JSON.stringify([null, [...routeToggleFormData(ENDPOINT, { enabled: false }).entries()]])}`,
    ]);
    expect(dispatchConnection).not.toHaveBeenCalled();
  });

  it('testet, löscht nach Bestätigung und aktualisiert danach immer', async () => {
    respond('testN8nEndpointAction', { ok: false, error: 'Keine Antwort.' });
    respond('deleteN8nEndpointAction', { ok: true });
    const hook = routes();
    hook.testRoute('endpoint-1', true, 'client.created');
    await settle();
    hook.deleteRoute('endpoint-1');
    await settle();
    expect(log).toEqual([
      'transition',
      'testN8nEndpointAction:["endpoint-1",true,"client.created"]',
      'refresh',
      'confirm:Diese Route und ihre Event-Abonnements entfernen?',
      'transition',
      'deleteN8nEndpointAction:["endpoint-1"]',
      'refresh',
    ]);
  });
});

describe('Betriebs-Hook', () => {
  function status(overrides: Partial<N8nSetupStatus> = {}): N8nSetupStatus {
    return {
      failedDeliveries: [
        { id: 'd1', targetUrl: 'https://ziel.example/a' },
        { id: 'd2', targetUrl: 'https://ziel.example/b' },
      ],
      hasMoreFailedDeliveries: true,
      ...overrides,
    } as unknown as N8nSetupStatus;
  }

  it('lädt ab der letzten sichtbaren Zustellung nach und ohne Cursor gar nicht', async () => {
    respond('listFailedN8nDeliveriesAction', { ok: true, deliveries: [], nextCursor: null });
    probe(() =>
      useN8nDeliveryOperations(
        status({ failedDeliveries: [], hasMoreFailedDeliveries: false }),
        runtime(),
      ),
    ).loadMoreFailedDeliveries();
    probe(() => useN8nDeliveryOperations(status(), runtime())).loadMoreFailedDeliveries();
    await settle();
    expect(log).toEqual(['transition', 'listFailedN8nDeliveriesAction:["d2"]']);
  });

  it('bestätigt Wiederholen, Quittieren, Zuordnen und Abschließen vor der Aktion', async () => {
    respond('retryN8nDeliveryAction', { ok: true });
    respond('acknowledgeN8nDeliveryAction', { ok: true });
    respond('replayUnroutedN8nEventAction', { ok: true });
    respond('skipUnroutedN8nEventAction', { ok: true });
    const hook = probe(() => useN8nDeliveryOperations(status(), runtime()));
    hook.retryDelivery('d1', 'https://ziel.example/a');
    await settle();
    hook.acknowledgeDelivery('d2');
    await settle();
    hook.replayUnroutedEvent('e1', 'request.opened', '2026-10-02T09:00:00.000Z');
    await settle();
    hook.skipUnroutedEvent('e1', 'request.opened');
    await settle();
    expect(log).toEqual([
      'confirm:Zustellung erneut an dieses unveränderte Ziel senden?\n\nhttps://ziel.example/a',
      'transition',
      'retryN8nDeliveryAction:["d1"]',
      'refresh',
      'confirm:Diesen Fehler ohne erneuten Versand administrativ abschließen? Die Zustellung wird als übersprungen markiert und die Entscheidung revisionsprotokolliert.',
      'transition',
      'acknowledgeN8nDeliveryAction:["d2"]',
      'refresh',
      'confirm:Das gespeicherte Event „request.opened“ vom 02.10.26, 11:00 enthält möglicherweise vertrauliche Daten. Jetzt an die aktuell konfigurierten Ziele senden?',
      'transition',
      'replayUnroutedN8nEventAction:["e1"]',
      'refresh',
      'confirm:Event „request.opened“ dauerhaft ohne n8n-Versand abschließen? Diese Entscheidung wird protokolliert.',
      'transition',
      'skipUnroutedN8nEventAction:["e1"]',
      'refresh',
    ]);
  });
});
