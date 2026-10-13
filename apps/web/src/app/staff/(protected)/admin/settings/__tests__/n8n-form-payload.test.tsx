// @vitest-environment jsdom
// n8n-Adminformular (K-04-Folgearbeit): „Verbindung speichern“ und „API testen“
// senden denselben Payload aus dem kontrollierten Zustand, inklusive der
// Keep-Flags für gespeicherte Secrets. Klicktest in jsdom (B-08, Welle 15);
// ersetzt die Quelltextprüfung aus presentation-extraction.test.ts. Die fünf
// Stufen des Fortschritts prüft n8n-form-render.test.tsx am gerenderten Stepper.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import type { N8nSetupStatus } from '@/server/n8n/status';

const h = vi.hoisted(() => ({
  saveN8n: vi.fn(),
  testN8nApi: vi.fn(),
  router: { refresh: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
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
  saveN8nAction: h.saveN8n,
  saveN8nEndpointAction: vi.fn(),
  skipUnroutedN8nEventAction: vi.fn(),
  testN8nApiAction: h.testN8nApi,
  testN8nEndpointAction: vi.fn(),
}));

import { N8nForm } from '../n8n-form';
import type { N8nBrowserConfig } from '../n8n-form-types';

const INITIAL: N8nBrowserConfig = {
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
  callbackConfigured: true,
  callbackScopes: [],
  healthCheckedAt: null,
  healthOk: null,
  healthError: null,
  source: 'CONNECTION',
};

const STATUS: N8nSetupStatus = {
  connectionId: 'connection-1',
  enabled: true,
  routingMode: 'EXPLICIT',
  callbackConfigured: true,
  endpointCount: 0,
  activeEndpointCount: 0,
  subscriptionCount: 0,
  deliveryCounts: { pending: 0, delivered: 0, failed: 0, skipped: 0, unrouted: 0 },
  unroutedEvents: [],
  recentUnroutedEvents: [],
  endpoints: [],
  failedDeliveries: [],
  hasMoreFailedDeliveries: false,
  recentDeliveries: [],
};

function entries(data: unknown): [string, FormDataEntryValue][] {
  expect(data).toBeInstanceOf(FormData);
  return [...(data as FormData).entries()];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.saveN8n.mockResolvedValue({ ok: false, error: 'nicht gespeichert' });
  h.testN8nApi.mockResolvedValue({ ok: true, message: 'API erreichbar' });
});

describe('n8n-Verbindung: Speichern und API-Test mit demselben Payload', () => {
  it('sendet den angezeigten Stand samt Keep-Flags an beide Actions', async () => {
    render(
      <N8nForm
        initial={INITIAL}
        status={STATUS}
        events={N8N_EVENT_CATALOG}
        bundledWorkflows={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^n8n-Oberfläche/), {
      target: { value: 'https://ui.kanzlei.example' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'API testen' }));
    });
    await waitFor(() => expect(h.testN8nApi).toHaveBeenCalledOnce());
    expect(h.testN8nApi.mock.calls[0]![0]).toBeNull();
    const tested = entries(h.testN8nApi.mock.calls[0]![1]);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verbindung speichern' }));
    });
    await waitFor(() => expect(h.saveN8n).toHaveBeenCalledOnce());
    const saved = entries(h.saveN8n.mock.calls[0]![1]);

    expect(saved).toEqual(tested);
    expect(Object.fromEntries(saved)).toMatchObject({
      name: 'Kanzlei n8n',
      routingMode: 'EXPLICIT',
      enabled: 'on',
      uiBaseUrl: 'https://ui.kanzlei.example',
      apiBaseUrl: 'https://n8n.kanzlei.example/api/v1',
      apiKey: '',
      keepApiKey: 'on',
      keepHmac: 'on',
    });
  });
});
