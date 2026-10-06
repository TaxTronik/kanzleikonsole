// n8n-Adminformular: reine Bereichs-Reducer, Aktionspayloads und Meldungen.
// Die Erwartungen entsprechen dem Verhalten vor der Aufteilung (K-04) — gleiche
// FormData-Reihenfolge, gleiche Pending-/Fehler-/Bestätigungstexte.

import { describe, expect, it, vi } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import type { N8nEndpointView, N8nRecentDeliveryView } from '@/server/n8n/status';
import {
  CALLBACK_ROTATION_CONFIRMATION,
  DELIVERY_ACKNOWLEDGE_CONFIRMATION,
  EMPTY_ROUTE,
  ROUTE_DELETE_CONFIRMATION,
  WEBHOOK_DISCOVERY_FAILED,
  WORKFLOW_LIST_FAILED,
  appendFailedDeliveries,
  applyUpdate,
  createN8nCallbackState,
  createN8nDeliveriesState,
  createN8nRoutesState,
  createN8nWorkflowsState,
  deliveryRetryConfirmation,
  deliveryStatusChanged,
  discoveredRouteCanBeSaved,
  discoveredRouteDraft,
  isExplicitConnectionActive,
  n8nCallbackReducer,
  n8nDeliveriesReducer,
  n8nRoutesReducer,
  n8nWorkflowsReducer,
  routeDraftFormData,
  routeDraftFromEndpoint,
  routeTestKey,
  routeToggleFormData,
  routeToggleKey,
  selectedDiscoveredRouteKey,
  syncConnectionActivation,
  unroutedReplayConfirmation,
  unroutedSkipConfirmation,
  workflowImportInput,
  type N8nDeliveriesState,
} from '../n8n-form-state';
import type { RouteDraft } from '../n8n-form-types';

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

function delivery(id: string): N8nRecentDeliveryView {
  return {
    id,
    eventId: `outbox-${id}`,
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
  };
}

const ok = { ok: true, message: 'Erledigt.' };
const failed = { ok: false, error: 'Fehlgeschlagen.' };

describe('applyUpdate', () => {
  it('übernimmt Werte und Updater-Funktionen wie useState', () => {
    expect(applyUpdate('alt', 'neu')).toBe('neu');
    expect(applyUpdate(['a'], (current) => [...current, 'b'])).toEqual(['a', 'b']);
  });
});

describe('Verbindung', () => {
  it('gilt nur mit expliziten Routen als aktiv', () => {
    expect(isExplicitConnectionActive({ enabled: true, routingMode: 'EXPLICIT' })).toBe(true);
    expect(isExplicitConnectionActive({ enabled: true, routingMode: 'LEGACY' })).toBe(false);
    expect(isExplicitConnectionActive({ enabled: false, routingMode: 'EXPLICIT' })).toBe(false);
  });

  it('übernimmt eine serverseitige Aktivierung in den Verbindungsstatus', () => {
    const dispatch = vi.fn();
    syncConnectionActivation(dispatch, { ok: true });
    expect(dispatch).not.toHaveBeenCalled();
    syncConnectionActivation(dispatch, { ok: true, connectionActivated: true });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'patch',
      value: { enabled: true, routingMode: 'EXPLICIT' },
    });
  });
});

describe('Rückkanal-Reducer', () => {
  const bundled = [
    { callbackScopes: ['clients:read'] },
    { callbackScopes: ['requests:write', 'clients:read'] },
  ];

  it('startet mit gespeicherten Scopes oder der Vereinigung der Vorlagen-Scopes', () => {
    const stored = ['gwg:read'];
    expect(
      createN8nCallbackState({
        initial: { callbackScopes: stored, callbackConfigured: true },
        bundledWorkflows: bundled,
      }),
    ).toEqual({ scopes: stored, configured: true, result: null });
    expect(
      createN8nCallbackState({
        initial: { callbackScopes: [], callbackConfigured: false },
        bundledWorkflows: bundled,
      }).scopes,
    ).toEqual(['clients:read', 'requests:write']);
  });

  it('pflegt Scopes per Updater und behält bei unveränderten Werten die Identität', () => {
    const state = createN8nCallbackState({
      initial: { callbackScopes: ['a'], callbackConfigured: false },
      bundledWorkflows: [],
    });
    const added = n8nCallbackReducer(state, {
      type: 'scopes',
      update: (current) => [...current, 'b'],
    });
    expect(added.scopes).toEqual(['a', 'b']);
    expect(n8nCallbackReducer(added, { type: 'result', update: null })).toBe(added);
  });

  it('markiert den Rückkanal nur nach erfolgreicher Rotation als eingerichtet', () => {
    const state = createN8nCallbackState({
      initial: { callbackScopes: ['a'], callbackConfigured: false },
      bundledWorkflows: [],
    });
    const rejected = n8nCallbackReducer(state, { type: 'rotated', result: failed });
    expect(rejected).toEqual({ ...state, result: failed });
    const credential = { keyId: 'k', token: 't', baseUrl: 'https://cb.example', scopes: ['a'] };
    const rotated = n8nCallbackReducer(rejected, {
      type: 'rotated',
      result: { ok: true, credential },
    });
    expect(rotated).toMatchObject({ configured: true, result: { ok: true, credential } });
    expect(n8nCallbackReducer(rotated, { type: 'rotated', result: failed }).configured).toBe(true);
  });

  it('übernimmt aus dem Import nur Konfiguration und einmaliges Credential', () => {
    const state = createN8nCallbackState({
      initial: { callbackScopes: ['a'], callbackConfigured: false },
      bundledWorkflows: [],
    });
    expect(n8nCallbackReducer(state, { type: 'imported', result: ok })).toBe(state);
    const configured = n8nCallbackReducer(state, {
      type: 'imported',
      result: { ok: true, callbackConfigured: true },
    });
    expect(configured).toEqual({ ...state, configured: true });
    const credential = { keyId: 'k', token: 't', baseUrl: 'https://cb.example', scopes: [] };
    const withCredential = { ok: true, credential };
    expect(
      n8nCallbackReducer(configured, { type: 'imported', result: withCredential }).result,
    ).toBe(withCredential);
  });

  it('nennt die bisherige Bestätigung der Rotation', () => {
    expect(CALLBACK_ROTATION_CONFIRMATION).toBe(
      'Das bisherige Callback-Token wird sofort ungültig. Wirklich rotieren?',
    );
  });
});

describe('Workflow-Reducer', () => {
  const initial = () => createN8nWorkflowsState([{ templateId: 'tpl.a' }, { templateId: 'tpl.b' }]);

  it('wählt alle Vorlagen vor und startet ohne Ergebnisse', () => {
    expect(initial()).toEqual({
      selectedTemplates: ['tpl.a', 'tpl.b'],
      mailFrom: '',
      gwgOfficerEmail: '',
      workflows: null,
      workflowError: null,
      discovered: null,
      discoveryError: null,
      importResult: null,
    });
  });

  it('baut den Import-Payload in unveränderter Feldreihenfolge', () => {
    let state = n8nWorkflowsReducer(initial(), {
      type: 'templates',
      update: (current) => current.filter((id) => id !== 'tpl.a'),
    });
    state = n8nWorkflowsReducer(state, { type: 'templates', update: (c) => [...c, 'tpl.a'] });
    state = n8nWorkflowsReducer(state, { type: 'mail-from', update: 'Kanzlei <k@example.de>' });
    state = n8nWorkflowsReducer(state, { type: 'gwg-officer-email', update: 'gwg@example.de' });
    const input = workflowImportInput(state);
    expect(Object.keys(input)).toEqual(['templateIds', 'smtpFrom', 'gwgOfficerEmail']);
    expect(input).toEqual({
      templateIds: ['tpl.b', 'tpl.a'],
      smtpFrom: 'Kanzlei <k@example.de>',
      gwgOfficerEmail: 'gwg@example.de',
    });
  });

  it('meldet Ladefehler mit Server- oder Standardtext', () => {
    const rows = [{ id: 'wf', name: 'W', active: true, updatedAt: '2026-10-01T00:00:00.000Z' }];
    const requested = n8nWorkflowsReducer(
      { ...initial(), workflowError: 'alt' },
      { type: 'workflows-requested' },
    );
    expect(requested.workflowError).toBeNull();
    expect(
      n8nWorkflowsReducer(requested, { type: 'workflows-loaded', result: { ok: false } })
        .workflowError,
    ).toBe('Workflow-Liste konnte nicht geladen werden.');
    expect(WORKFLOW_LIST_FAILED).toBe('Workflow-Liste konnte nicht geladen werden.');
    expect(
      n8nWorkflowsReducer(requested, { type: 'workflows-loaded', result: failed }).workflowError,
    ).toBe('Fehlgeschlagen.');
    expect(
      n8nWorkflowsReducer(requested, {
        type: 'workflows-loaded',
        result: { ok: true, workflows: rows },
      }).workflows,
    ).toBe(rows);
    expect(
      n8nWorkflowsReducer(requested, { type: 'workflows-loaded', result: { ok: true } }).workflows,
    ).toEqual([]);
  });

  it('aktualisiert nach dem Import nur bei erfolgreicher Workflow-Liste', () => {
    const imported = n8nWorkflowsReducer(
      n8nWorkflowsReducer(initial(), { type: 'import-started' }),
      { type: 'imported', result: ok },
    );
    expect(imported.importResult).toBe(ok);
    expect(n8nWorkflowsReducer(imported, { type: 'workflows-refreshed', result: failed })).toBe(
      imported,
    );
    expect(
      n8nWorkflowsReducer(imported, { type: 'workflows-refreshed', result: { ok: true } })
        .workflows,
    ).toEqual([]);
    expect(n8nWorkflowsReducer(imported, { type: 'import-started' }).importResult).toBeNull();
  });

  it('meldet Fehler der Webhook-Erkennung mit Server- oder Standardtext', () => {
    const requested = n8nWorkflowsReducer(
      { ...initial(), discoveryError: 'alt' },
      { type: 'discovery-requested' },
    );
    expect(requested.discoveryError).toBeNull();
    expect(
      n8nWorkflowsReducer(requested, { type: 'discovered', result: { ok: false } }).discoveryError,
    ).toBe('Webhook-Erkennung fehlgeschlagen.');
    expect(WEBHOOK_DISCOVERY_FAILED).toBe('Webhook-Erkennung fehlgeschlagen.');
    expect(
      n8nWorkflowsReducer(requested, { type: 'discovered', result: { ok: true } }).discovered,
    ).toEqual([]);
  });
});

describe('Routen-Reducer', () => {
  const draft: RouteDraft = {
    id: '',
    name: 'Eigene Route',
    productionUrl: 'https://n8n.kanzlei.example/webhook/eigen',
    testUrl: 'https://n8n.kanzlei.example/webhook-test/eigen',
    workflowId: '',
    workflowName: '',
    workflowNodeId: '',
    source: 'CUSTOM',
    enabled: true,
    testMode: true,
    events: ['client.created', 'gwg.verified'],
  };

  it('lädt Entwürfe vorbefüllt und verwirft dabei Zusatz-Event und Ergebnis', () => {
    const edited = n8nRoutesReducer(
      { ...createN8nRoutesState(), customEvent: 'workflow.step.x', result: failed },
      { type: 'draft-loaded', draft },
    );
    expect(edited).toEqual({ draft, customEvent: '', result: null, testResults: {} });
    const renamed = n8nRoutesReducer(edited, {
      type: 'draft',
      update: (current) => ({ ...current, name: 'Neu' }),
    });
    expect(renamed.draft).toEqual({ ...draft, name: 'Neu' });
    expect(n8nRoutesReducer(renamed, { type: 'custom-event', update: 'x' }).customEvent).toBe('x');
  });

  it('setzt den Editor nur nach erfolgreichem Speichern zurück', () => {
    const editing = { ...createN8nRoutesState(), draft, customEvent: 'workflow.step.x' };
    const cleared = n8nRoutesReducer({ ...editing, result: failed }, { type: 'result-cleared' });
    expect(cleared.result).toBeNull();
    expect(n8nRoutesReducer(editing, { type: 'saved', result: failed })).toEqual({
      ...editing,
      result: failed,
    });
    expect(n8nRoutesReducer(editing, { type: 'saved', result: ok })).toEqual({
      ...editing,
      draft: EMPTY_ROUTE,
      customEvent: '',
      result: ok,
    });
  });

  it('zeigt nur fehlgeschlagenes Löschen als Routenergebnis', () => {
    const state = createN8nRoutesState();
    expect(n8nRoutesReducer(state, { type: 'deleted', result: ok })).toBe(state);
    expect(n8nRoutesReducer(state, { type: 'deleted', result: failed }).result).toBe(failed);
    expect(ROUTE_DELETE_CONFIRMATION).toBe('Diese Route und ihre Event-Abonnements entfernen?');
  });

  it('legt Schalter- und Testergebnisse unter den Schlüsseln der Routenkarte ab', () => {
    expect(routeToggleKey('e1')).toBe('e1:toggle');
    expect(routeTestKey('e1', false, 'taxtronik.ping')).toBe('e1:prod:taxtronik.ping');
    expect(routeTestKey('e1', true, 'client.created')).toBe('e1:test:client.created');

    let state = n8nRoutesReducer(createN8nRoutesState(), {
      type: 'toggled',
      endpointId: 'e1',
      result: ok,
    });
    state = n8nRoutesReducer(state, { type: 'test-started', key: 'e1:prod:taxtronik.ping' });
    expect(state.testResults).toEqual({
      'e1:toggle': ok,
      'e1:prod:taxtronik.ping': { ok: true, message: 'Prüfung läuft…' },
    });
    state = n8nRoutesReducer(state, {
      type: 'tested',
      key: 'e1:prod:taxtronik.ping',
      result: failed,
    });
    expect(state.testResults['e1:prod:taxtronik.ping']).toBe(failed);
  });

  it('bearbeitet Legacy-Routen als eigene Route in Entwurfsreihenfolge', () => {
    const legacy = routeDraftFromEndpoint(endpoint({ source: 'LEGACY', testMode: true }));
    expect(Object.keys(legacy)).toEqual(Object.keys(EMPTY_ROUTE));
    expect(legacy).toEqual({
      id: 'endpoint-1',
      name: 'Mandant angelegt',
      productionUrl: 'https://n8n.kanzlei.example/webhook/client-created',
      testUrl: 'https://n8n.kanzlei.example/webhook-test/client-created',
      workflowId: 'wf-1',
      workflowName: 'TaxTronik Mandanten',
      workflowNodeId: 'node-1',
      source: 'CUSTOM',
      enabled: true,
      testMode: true,
      events: ['client.created', 'taxtronik.ping'],
    });
    expect(routeDraftFromEndpoint(endpoint()).source).toBe('MANAGED');
  });

  it('hält übernommene Webhooks in Entwurfsreihenfolge und erkennt die Auswahl', () => {
    const selected = discoveredRouteDraft(
      {
        workflowId: 'wf-9',
        workflowName: 'TaxTronik Mandanten',
        workflowActive: true,
        nodeId: 'node-9',
        nodeName: 'Webhook',
        path: 'client.created',
        productionUrl: 'https://n8n.kanzlei.example/webhook/client.created',
        testUrl: '',
      },
      [],
      N8N_EVENT_CATALOG,
    );
    expect(Object.keys(selected)).toEqual(Object.keys(EMPTY_ROUTE));
    expect(selectedDiscoveredRouteKey(selected)).toBe('wf-9:node-9');
    expect(discoveredRouteCanBeSaved(selected)).toBe(true);
    expect(selectedDiscoveredRouteKey({ ...selected, id: 'gespeichert' })).toBeNull();
    expect(selectedDiscoveredRouteKey({ ...selected, workflowNodeId: '' })).toBeNull();
    expect(discoveredRouteCanBeSaved({ ...selected, events: [] })).toBe(false);
    expect(discoveredRouteCanBeSaved({ ...selected, productionUrl: '' })).toBe(false);
  });

  it('serialisiert den Editor-Entwurf unverändert', () => {
    const data = routeDraftFormData(draft, '  workflow.step.mein_schritt ');
    expect([...data.entries()]).toEqual([
      ['id', ''],
      ['name', 'Eigene Route'],
      ['productionUrl', 'https://n8n.kanzlei.example/webhook/eigen'],
      ['testUrl', 'https://n8n.kanzlei.example/webhook-test/eigen'],
      ['workflowId', ''],
      ['workflowName', ''],
      ['workflowNodeId', ''],
      ['source', 'CUSTOM'],
      ['enabled', 'on'],
      ['testMode', 'on'],
      ['events', 'client.created'],
      ['events', 'gwg.verified'],
      ['events', 'workflow.step.mein_schritt'],
    ]);
    const plain = routeDraftFormData({ ...draft, enabled: false, testMode: false }, '   ');
    expect(plain.has('enabled')).toBe(false);
    expect(plain.has('testMode')).toBe(false);
    expect(plain.getAll('events')).toEqual(['client.created', 'gwg.verified']);
  });

  it('serialisiert Ein-Klick-Schalter mit gespeicherten Werten und geänderten Flags', () => {
    expect([...routeToggleFormData(endpoint(), { enabled: false }).entries()]).toEqual([
      ['id', 'endpoint-1'],
      ['name', 'Mandant angelegt'],
      ['productionUrl', 'https://n8n.kanzlei.example/webhook/client-created'],
      ['testUrl', 'https://n8n.kanzlei.example/webhook-test/client-created'],
      ['workflowId', 'wf-1'],
      ['workflowName', 'TaxTronik Mandanten'],
      ['workflowNodeId', 'node-1'],
      ['source', 'MANAGED'],
      ['events', 'client.created'],
      ['events', 'taxtronik.ping'],
    ]);
    const legacy = routeToggleFormData(endpoint({ source: 'LEGACY', enabled: false }), {
      testMode: true,
    });
    expect(legacy.get('source')).toBe('CUSTOM');
    expect(legacy.has('enabled')).toBe(false);
    expect(legacy.get('testMode')).toBe('on');
  });
});

describe('Betriebs-Reducer', () => {
  const status = {
    failedDeliveries: [delivery('d1'), delivery('d2')],
    hasMoreFailedDeliveries: true,
  };
  const initial = (): N8nDeliveriesState => createN8nDeliveriesState(status);

  it('startet die Fehlerliste mit dem Cursor der letzten Zustellung', () => {
    expect(initial()).toEqual({
      source: status,
      failedDeliveries: status.failedDeliveries,
      failedCursor: 'd2',
      hasMoreFailedDeliveries: true,
      operationResult: null,
      retryResults: {},
      replayResults: {},
    });
    expect(
      createN8nDeliveriesState({ failedDeliveries: [], hasMoreFailedDeliveries: false })
        .failedCursor,
    ).toBeNull();
  });

  it('übernimmt nur einen neuen Server-Stand und behält Aktionsergebnisse', () => {
    const state = { ...initial(), operationResult: ok, retryResults: { d1: ok } };
    expect(deliveryStatusChanged(state, status)).toBe(false);
    expect(deliveryStatusChanged(state, { ...status })).toBe(false);
    expect(deliveryStatusChanged(state, { ...status, hasMoreFailedDeliveries: false })).toBe(true);
    const next = { failedDeliveries: [delivery('d5')], hasMoreFailedDeliveries: false };
    expect(deliveryStatusChanged(state, next)).toBe(true);
    expect(n8nDeliveriesReducer(state, { type: 'status-received', status: next })).toEqual({
      ...state,
      source: next,
      failedDeliveries: next.failedDeliveries,
      failedCursor: 'd5',
      hasMoreFailedDeliveries: false,
    });
  });

  it('lädt weitere Seiten ohne Duplikate nach und meldet Fehler', () => {
    const requested = n8nDeliveriesReducer(
      { ...initial(), operationResult: ok },
      { type: 'page-requested' },
    );
    expect(requested.operationResult).toBeNull();
    const rejected = n8nDeliveriesReducer(requested, { type: 'page-loaded', result: failed });
    expect(rejected).toEqual({ ...requested, operationResult: failed });
    const loaded = n8nDeliveriesReducer(requested, {
      type: 'page-loaded',
      result: { ok: true, deliveries: [delivery('d2'), delivery('d3')], nextCursor: 'd3' },
    });
    expect(loaded.failedDeliveries.map((item) => item.id)).toEqual(['d1', 'd2', 'd3']);
    expect(loaded).toMatchObject({ failedCursor: 'd3', hasMoreFailedDeliveries: true });
    expect(
      n8nDeliveriesReducer(loaded, { type: 'page-loaded', result: { ok: true } }),
    ).toMatchObject({ failedCursor: null, hasMoreFailedDeliveries: false });
    expect(appendFailedDeliveries([delivery('a')], [delivery('a')]).map((d) => d.id)).toEqual([
      'a',
    ]);
  });

  it('zeigt die bisherigen Pending-Texte je Zustellung, Quittung und Event', () => {
    let state = n8nDeliveriesReducer(initial(), { type: 'retry-pending', deliveryId: 'd1' });
    expect(state.retryResults['d1']).toEqual({ ok: true, message: 'Wird eingeplant…' });
    state = n8nDeliveriesReducer(state, { type: 'retried', deliveryId: 'd1', result: failed });
    expect(state.retryResults['d1']).toBe(failed);

    state = n8nDeliveriesReducer(state, { type: 'acknowledge-pending' });
    expect(state.operationResult).toEqual({ ok: true, message: 'Fehler wird quittiert…' });
    state = n8nDeliveriesReducer(state, { type: 'acknowledged', result: ok });
    expect(state.operationResult).toBe(ok);

    state = n8nDeliveriesReducer(state, { type: 'replay-pending', eventId: 'e1' });
    expect(state.replayResults['e1']).toEqual({
      ok: true,
      message: 'Wird den aktuellen Routen zugeordnet…',
    });
    state = n8nDeliveriesReducer(state, { type: 'skip-pending', eventId: 'e2' });
    expect(state.replayResults['e2']).toEqual({ ok: true, message: 'Wird abgeschlossen…' });
    state = n8nDeliveriesReducer(state, { type: 'replayed', eventId: 'e2', result: ok });
    expect(state.replayResults).toEqual({
      e1: { ok: true, message: 'Wird den aktuellen Routen zugeordnet…' },
      e2: ok,
    });
  });

  it('formuliert die Bestätigungen wie bisher', () => {
    expect(deliveryRetryConfirmation('https://ziel.example/webhook')).toBe(
      'Zustellung erneut an dieses unveränderte Ziel senden?\n\nhttps://ziel.example/webhook',
    );
    expect(DELIVERY_ACKNOWLEDGE_CONFIRMATION).toBe(
      'Diesen Fehler ohne erneuten Versand administrativ abschließen? Die Zustellung wird als übersprungen markiert und die Entscheidung revisionsprotokolliert.',
    );
    expect(unroutedReplayConfirmation('request.opened', '2026-10-02T09:00:00.000Z')).toBe(
      'Das gespeicherte Event „request.opened“ vom 02.10.26, 11:00 enthält möglicherweise vertrauliche Daten. Jetzt an die aktuell konfigurierten Ziele senden?',
    );
    expect(unroutedSkipConfirmation('request.opened')).toBe(
      'Event „request.opened“ dauerhaft ohne n8n-Versand abschließen? Diese Entscheidung wird protokolliert.',
    );
  });
});
