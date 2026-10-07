// n8n-Verbindung speichern (K-04-Folgearbeit): Die „Betriebsart“ springt nach
// dem Speichern nicht mehr auf BUNDLED.
//
// React 19 setzt ein Formular zurück, nachdem es dessen `action`-Funktion
// selbst ausgeführt hat. Für ein kontrolliertes <select> setzt React kein
// `defaultSelected`; nach dem Reset zeigte „Betriebsart“ deshalb die erste
// Option (BUNDLED), obwohl der State den gewählten Modus hielt — und der
// nächste Submit las BUNDLED aus dem DOM. Ohne DOM-Testumgebung bildet der
// Test genau diese Regel nach: React führt die Action samt Reset nur aus, wenn
// kein onSubmit-Handler das Absenden verhindert hat.

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Zählt, ob die Action innerhalb einer Transition dispatcht wird (sonst bliebe
// `saving` aus useActionState stehen und React warnt).
const transitions = vi.hoisted(() => ({ active: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    startTransition: (scope: () => void) => {
      transitions.active += 1;
      try {
        actual.startTransition(scope);
      } finally {
        transitions.active -= 1;
      }
    },
  };
});

import { N8nConnectionSection } from '../n8n-connection-section';
import {
  createN8nConnectionState,
  n8nConnectionReducer,
  type N8nConnectionState,
} from '../n8n-connection-state';
import type { N8nBrowserConfig } from '../n8n-form-types';

type Element = ReactElement<{ children?: ReactNode } & Record<string, unknown>>;

function config(overrides: Partial<N8nBrowserConfig> = {}): N8nBrowserConfig {
  return {
    connectionId: 'connection-1',
    name: 'Kanzlei n8n',
    kind: 'CLOUD',
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

function props(initial: N8nBrowserConfig, connection: N8nConnectionState, saveAction = vi.fn()) {
  return {
    initial,
    connection,
    dispatchConnection: vi.fn(),
    saveAction,
    saving: false,
    busy: false,
    apiInstanceChanged: false,
    generateSecret: vi.fn(),
    testApi: vi.fn(),
    saveState: null,
    apiResult: null,
    copied: null,
    copy: vi.fn(),
  };
}

/** Erstes Element im (nicht gerenderten) Baum, auf das `match` passt. */
function find(node: ReactNode, match: (element: Element) => boolean): Element | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const element = child as Element;
    if (match(element)) return element;
    const nested = find(element.props.children, match);
    if (nested) return nested;
  }
  return undefined;
}

/** Submit wie im Browser mit React 19: erst onSubmit, dann ggf. Reacts Form-Action. */
function submit(form: Element): { reactRunsFormAction: boolean } {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  (form.props.onSubmit as ((value: typeof event) => void) | undefined)?.(event);
  return {
    reactRunsFormAction: !event.defaultPrevented && typeof form.props.action === 'function',
  };
}

/** Angezeigte Option eines kontrollierten Selects nach dem Submit. */
function shownAfterSubmit(select: Element, reactRunsFormAction: boolean): unknown {
  if (!reactRunsFormAction) return select.props.value;
  // Reacts Form-Action setzt das Formular danach zurück; ohne defaultSelected
  // zeigt das kontrollierte Select seine erste Option.
  const [first] = Children.toArray(select.props.children) as Element[];
  return first?.props.value;
}

let inTransition: boolean[] = [];

beforeEach(() => {
  inTransition = [];
});

function recordingSaveAction() {
  return vi.fn((_payload: FormData) => {
    inTransition.push(transitions.active > 0);
  });
}

describe('n8n-Verbindung speichern (K-04)', () => {
  it('behält nach dem Speichern die gewählte Betriebsart statt auf BUNDLED zu springen', () => {
    // Gespeichert ist CLOUD, gewählt wird „Eigene n8n-Instanz“.
    const initial = config({ kind: 'CLOUD' });
    const connection = n8nConnectionReducer(createN8nConnectionState(initial), {
      type: 'patch',
      value: { kind: 'SELF_HOSTED' },
    });
    const saveAction = recordingSaveAction();
    const tree = N8nConnectionSection(props(initial, connection, saveAction));
    const form = find(tree, (element) => element.type === 'form')!;
    const select = find(
      tree,
      (element) => element.type === 'select' && element.props.name === 'kind',
    )!;

    const { reactRunsFormAction } = submit(form);

    // Eigener Submit-Handler wie ActionForm: kein natives Absenden, kein Reset.
    expect(reactRunsFormAction).toBe(false);
    expect(shownAfterSubmit(select, reactRunsFormAction)).toBe('SELF_HOSTED');
    // Die Action läuft genau einmal, in einer Transition, mit dem gewählten Modus.
    expect(saveAction).toHaveBeenCalledOnce();
    expect(inTransition).toEqual([true]);
    expect(saveAction.mock.calls[0]![0].get('kind')).toBe('SELF_HOSTED');
    // Vor der Hydration postet das Formular weiter direkt an die Server-Action.
    expect(form.props.action).toBe(saveAction);
  });

  it('sendet genau die Felder, die das Formular selbst trägt, mit den sichtbaren Werten', () => {
    const initial = config({ hasSigningSecret: false });
    const connection = n8nConnectionReducer(createN8nConnectionState(initial), {
      type: 'patch',
      value: { routingMode: 'LEGACY', apiKey: 'neuer-key', keepApiKey: false },
    });
    const saveAction = recordingSaveAction();
    const sectionProps = props(initial, connection, saveAction);

    submit(find(N8nConnectionSection(sectionProps), (element) => element.type === 'form')!);

    const posted = saveAction.mock.calls[0]![0];
    const html = renderToStaticMarkup(<N8nConnectionSection {...sectionProps} />);
    const names = [...html.matchAll(/<(?:input|select|textarea)[^>]* name="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect([...posted.keys()].sort()).toEqual([...names].sort());
    expect(Object.fromEntries(posted.entries())).toEqual({
      name: 'Kanzlei n8n',
      kind: 'CLOUD',
      routingMode: 'LEGACY',
      enabled: 'on',
      uiBaseUrl: 'https://n8n.kanzlei.example',
      callbackBaseUrl: 'https://app.kanzlei.example',
      webhookBaseUrl: 'https://n8n.kanzlei.example/webhook',
      apiBaseUrl: 'https://n8n.kanzlei.example/api/v1',
      apiKey: 'neuer-key',
      hmacSecret: '',
    });
  });

  it('übernimmt das Speicherergebnis, ohne die gewählte Betriebsart zu verändern', () => {
    const chosen = n8nConnectionReducer(createN8nConnectionState(config({ kind: 'CLOUD' })), {
      type: 'patch',
      value: { kind: 'SELF_HOSTED', apiKey: 'neuer-key', keepApiKey: false },
    });

    expect(n8nConnectionReducer(chosen, { type: 'saved' })).toMatchObject({
      kind: 'SELF_HOSTED',
      apiKey: '',
      keepApiKey: true,
    });
  });
});
