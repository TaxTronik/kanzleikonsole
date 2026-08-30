import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const form = readFileSync(new URL('../n8n-form.tsx', import.meta.url), 'utf8');
const routeEditor = readFileSync(new URL('../route-editor-section.tsx', import.meta.url), 'utf8');
const deliveryOperations = readFileSync(
  new URL('../delivery-operations-section.tsx', import.meta.url),
  'utf8',
);
const connectionSection = readFileSync(
  new URL('../n8n-connection-section.tsx', import.meta.url),
  'utf8',
);
const actions = readFileSync(new URL('../n8n-actions.ts', import.meta.url), 'utf8');
const callbackSection = readFileSync(
  new URL('../n8n-callback-credentials-section.tsx', import.meta.url),
  'utf8',
);
const workflowsSection = readFileSync(
  new URL('../n8n-workflows-section.tsx', import.meta.url),
  'utf8',
);
const confirmedAction = readFileSync(
  new URL('../use-confirmed-action.ts', import.meta.url),
  'utf8',
);

describe('n8n-Adminformular – inkrementelle Komponentenstruktur', () => {
  it('delegiert Routen und Zustellbetrieb an kontrollierte Teilkomponenten', () => {
    expect(form).toContain('<RouteEditorSection');
    expect(form).toContain('<DeliveryOperationsSection');
    expect(form).not.toContain('id="n8n-route-editor"');
    expect(form).not.toContain('id="n8n-operation-heading"');
    expect(form).not.toContain('function RouteState');
    expect(form).not.toContain('function DeliveryState');
    expect(form).not.toContain('function Result');

    expect(routeEditor).toContain('id="n8n-route-editor"');
    expect(routeEditor).toContain('data-settings-no-track');
    expect(routeEditor).toContain('enabled: false');
    expect(routeEditor).toContain('<XCircle className="h-4 w-4" /> Verwerfen');
    expect(routeEditor).toContain('<Save className="h-4 w-4" /> Speichern');
    expect(routeEditor).toContain('items-center justify-end gap-2');
    expect(routeEditor).toContain("onTestRoute(endpoint.id, false, 'taxtronik.ping')");
    expect(routeEditor).toContain('onDeleteRoute(endpoint.id)');
    // Routen-Aktionen gebündelt im Radix-Overflow-Menü statt Button-Leiste.
    expect(routeEditor).toContain('<OverflowMenu>');
    expect(routeEditor).toContain('Route löschen');

    expect(deliveryOperations).not.toContain('id="n8n-operation-heading"');
    expect(deliveryOperations).toContain(
      'onReplayUnroutedEvent(item.id, item.event, item.occurredAt)',
    );
    expect(deliveryOperations).toContain('onRetryDelivery(delivery.id, delivery.targetUrl)');
    expect(deliveryOperations).toContain('onAcknowledgeDelivery(delivery.id)');
  });

  it('delegiert auch Verbindung, Callback-Credentials und Workflow-Import', () => {
    expect(form).toContain('<N8nConnectionSection');
    expect(form).toContain('<N8nCallbackCredentialsSection');
    expect(form).toContain('<N8nWorkflowsSection');
    expect(form).not.toContain('id="n8n-connection-heading"');
    expect(form).not.toContain('id="n8n-credentials-heading"');
    expect(form).not.toContain('id="n8n-workflows-heading"');

    expect(connectionSection).not.toContain('id="n8n-connection-heading"');
    expect(connectionSection).toContain('Die verwaltete n8n-Instanz ist bereits verbunden.');
    expect(connectionSection).toContain("initial.kind !== 'BUNDLED'");
    expect(connectionSection).toContain('canTestN8nApi(apiBaseUrl, apiKey, keepApiKey)');
    expect(connectionSection).toContain('Ein aktuelles HMAC-Signatur-Secret ist gespeichert.');
    expect(connectionSection).toContain('Neues HMAC-Secret erzeugt, noch nicht gespeichert.');
    expect(routeEditor).toContain("'Integration aktivieren'");
    expect(callbackSection).not.toContain('id="n8n-credentials-heading"');
    expect(callbackSection).toContain('Die Key-ID allein ist kein Credential.');
    expect(callbackSection).toContain('Bearer &lt;Key-ID&gt;.&lt;Callback-Token&gt;');
    expect(workflowsSection).not.toContain('id="n8n-workflows-heading"');
  });

  it('rahmtd die fünf Sektionen als geführte Stepper-Stages', () => {
    // Jede Sektion steckt in einer Stage; die Titel wandern aus den Sektions-
    // h3-Headern (entfernt) in das Stage-Framing des Orchestrators.
    expect(form.match(/<Stage/g)?.length).toBe(5);
    expect(form).toContain('title="n8n-Instanz verbinden"');
    expect(form).toContain('title="Rückkanal n8n → TaxTronik"');
    expect(form).toContain('title="Workflows einrichten"');
    expect(form).toContain('title="Routen — Events an Workflows"');
    expect(form).toContain('title="Betrieb — Zustellung & Diagnose"');
    // Fünf Stepper-Stufen 1:1 auf die Stages (vorher 4 Pillen vs. 5 Sektionen).
    expect(form).toContain("label: 'Verbinden'");
    expect(form).toContain("label: 'Rückkanal'");
    expect(form).toContain("label: 'Workflows'");
    expect(form).toContain("label: 'Routen'");
    expect(form).toContain("label: 'Betrieb'");
    expect(form).toContain('withActiveStep(setupSteps)');
  });

  it('macht erkannte Webhook-Routen direkt an ihrer Fundstelle speicherbar', () => {
    expect(form).toContain('function discoveredRouteDraft(');
    expect(form).toContain('new Set([...(managedWorkflow?.events ?? []), item.path])');
    expect(form).toContain('saveSelectedDiscovered={persistRouteDraft}');
    expect(workflowsSection).toContain(
      'selectedDiscoveredKey === `${item.workflowId}:${item.nodeId}`',
    );
    expect(workflowsSection).toContain('onClick={saveSelectedDiscovered}');
    expect(workflowsSection).toContain('Route speichern');
    expect(workflowsSection).toContain('Das zum Workflow gehörende Event ist vorausgewählt.');
    expect(actions).toContain('enabled: data.enabled,');
    expect(actions).not.toContain('activationBlocked');
  });

  it('verwendet genau eine globale Transition und den gemeinsamen Bestätigungsablauf', () => {
    expect(form.match(/useConfirmedAction\(\{/g) ?? []).toHaveLength(7);
    expect(form.match(/useTransition\(\)/g) ?? []).toHaveLength(1);
    expect(form).not.toMatch(/\b(?:window\.)?confirm\(/);
    expect(confirmedAction).toContain('startTransition: TransitionStartFunction');

    const fragments = [
      'await confirmDialog(message)',
      'onPending?.(...args)',
      'startTransition(async () => {',
      'await action(...args)',
      'onResult?.(result, ...args)',
    ];
    let previous = -1;
    for (const fragment of fragments) {
      const current = confirmedAction.indexOf(fragment);
      expect(current, `Reihenfolge/Marker verletzt: ${fragment}`).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('bündelt den Connection-Form-State in einem Reducer', () => {
    expect(form).toContain('const [connection, dispatchConnection] = useReducer(');
    expect(form).toContain('n8nConnectionReducer');
    expect(form).toContain('createN8nConnectionState');
    expect(form).not.toMatch(
      /set(?:Name|Kind|RoutingMode|Enabled|UiBaseUrl|CallbackBaseUrl|WebhookBaseUrl|ApiBaseUrl|ApiKey|KeepApiKey|HmacSecret|KeepHmac)\b/,
    );
  });

  it('bewahrt Server-Action-Argumente, Result-State und Refresh-Semantik', () => {
    const actionCalls = [
      'rotateN8nCallbackCredentialAction(callbackScopes)',
      'deleteN8nEndpointAction(endpointId)',
      'retryN8nDeliveryAction(deliveryId)',
      'acknowledgeN8nDeliveryAction(deliveryId)',
      'replayUnroutedN8nEventAction(eventId)',
      'skipUnroutedN8nEventAction(eventId)',
      'resetN8nAction()',
    ];
    for (const actionCall of actionCalls) expect(form).toContain(actionCall);

    expect(form).toContain("message: 'Wird eingeplant…'");
    expect(form).toContain("message: 'Fehler wird quittiert…'");
    expect(form).toContain("message: 'Wird den aktuellen Routen zugeordnet…'");
    expect(form).toContain("message: 'Wird abgeschlossen…'");
    // 11: inkl. toggleRoute (Ein-Klick-Aktivierung an der Routen-Karte).
    expect(form.match(/router\.refresh\(\);/g) ?? []).toHaveLength(11);
    expect(form.match(/window\.location\.reload\(\)/g) ?? []).toHaveLength(1);
  });

  it('importiert Callback-Vorlagen geführt statt an optionalen Werten abzubrechen', () => {
    expect(actions).toContain('prepareN8nCallbackImport(');
    expect(actions).toContain('DEFAULT_GWG_OFFICER_EMAIL');
    expect(actions).toContain('bindN8nHeaderCredential(materialized, callbackSetup.binding)');
    expect(actions).not.toContain("throw new Error('Callback-Token fehlt')");
    expect(actions).not.toContain(
      "throw new Error('E-Mail der GwG-verantwortlichen Person fehlt')",
    );
    expect(form).toContain('if (result.credential) setCallbackResult(result)');
  });
});
