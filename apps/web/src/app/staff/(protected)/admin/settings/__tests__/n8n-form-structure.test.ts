import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const form = readFileSync(new URL('../n8n-form.tsx', import.meta.url), 'utf8');
const routeEditor = readFileSync(new URL('../route-editor-section.tsx', import.meta.url), 'utf8');
const deliveryOperations = readFileSync(
  new URL('../delivery-operations-section.tsx', import.meta.url),
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
    expect(routeEditor).toContain('4. Event-Routen');
    expect(routeEditor).toContain('enabled: false');
    expect(routeEditor).toContain("onTestRoute(endpoint.id, false, 'taxtronik.ping')");
    expect(routeEditor).toContain('onDeleteRoute(endpoint.id)');

    expect(deliveryOperations).toContain('id="n8n-operation-heading"');
    expect(deliveryOperations).toContain('5. Zustellung & Betrieb');
    expect(deliveryOperations).toContain(
      'onReplayUnroutedEvent(item.id, item.event, item.occurredAt)',
    );
    expect(deliveryOperations).toContain('onRetryDelivery(delivery.id, delivery.targetUrl)');
    expect(deliveryOperations).toContain('onAcknowledgeDelivery(delivery.id)');
  });

  it('verwendet genau eine globale Transition und den gemeinsamen Bestätigungsablauf', () => {
    expect(form.match(/useConfirmedAction\(\{/g) ?? []).toHaveLength(7);
    expect(form.match(/useTransition\(\)/g) ?? []).toHaveLength(1);
    expect(form).not.toMatch(/\b(?:window\.)?confirm\(/);
    expect(confirmedAction).toContain('startTransition: TransitionStartFunction');

    const fragments = [
      'window.confirm(message)',
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
    expect(form.match(/router\.refresh\(\);/g) ?? []).toHaveLength(10);
    expect(form.match(/window\.location\.reload\(\)/g) ?? []).toHaveLength(1);
  });
});
