import { describe, expect, it } from 'vitest';
import {
  createN8nConnectionState,
  n8nConnectionReducer,
  type N8nConnectionState,
} from '../n8n-connection-state';

const initialConfig = {
  name: 'Kanzlei n8n',
  kind: 'SELF_HOSTED' as const,
  routingMode: 'EXPLICIT' as const,
  enabled: true,
  uiBaseUrl: 'https://n8n.example.de',
  callbackBaseUrl: 'https://taxtronik.example.de',
  webhookBaseUrl: 'https://n8n.example.de/webhook',
  apiBaseUrl: 'https://n8n.example.de/api/v1',
  hasApiKey: true,
  hasSigningSecret: false,
};

function state(): N8nConnectionState {
  return createN8nConnectionState(initialConfig);
}

describe('n8n-Verbindungsformular – Reducer-State', () => {
  it('initialisiert sichtbare Werte und gespeicherte Secret-Flags ohne Secret-Inhalt', () => {
    expect(state()).toMatchObject({
      name: initialConfig.name,
      kind: initialConfig.kind,
      routingMode: initialConfig.routingMode,
      enabled: true,
      apiKey: '',
      keepApiKey: true,
      hmacSecret: '',
      hasSigningSecret: false,
      keepHmac: false,
    });
  });

  it('aktualisiert gekoppelte Formularfelder atomar', () => {
    const disabled = n8nConnectionReducer(state(), {
      type: 'patch',
      value: { routingMode: 'DISABLED', enabled: false },
    });
    const replacementKey = n8nConnectionReducer(disabled, {
      type: 'patch',
      value: { apiKey: 'new-key', keepApiKey: false },
    });

    expect(replacementKey).toMatchObject({
      routingMode: 'DISABLED',
      enabled: false,
      apiKey: 'new-key',
      keepApiKey: false,
    });
    expect(replacementKey.name).toBe(initialConfig.name);
  });

  it('behält nach dem Speichern den sichtbaren HMAC-Konfigurationsstatus', () => {
    const generated = n8nConnectionReducer(state(), {
      type: 'generated-signing-secret',
      secret: 'generated-secret',
    });
    expect(generated).toMatchObject({ hmacSecret: 'generated-secret', keepHmac: false });

    const saved = n8nConnectionReducer(
      { ...generated, apiKey: 'new-key', keepApiKey: false },
      { type: 'saved' },
    );
    expect(saved).toMatchObject({
      apiKey: '',
      hmacSecret: '',
      hasSigningSecret: true,
      keepApiKey: true,
      keepHmac: true,
    });
    expect(saved.name).toBe(initialConfig.name);
  });

  it('behauptet ohne vorhandenes oder neues Secret keinen gespeicherten HMAC-Status', () => {
    const saved = n8nConnectionReducer(state(), { type: 'saved' });
    expect(saved).toMatchObject({
      hmacSecret: '',
      hasSigningSecret: false,
      keepHmac: false,
    });
  });
});
