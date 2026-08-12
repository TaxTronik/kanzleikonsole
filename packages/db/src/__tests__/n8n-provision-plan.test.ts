import { describe, expect, it } from 'vitest';
import { buildManagedN8nProvisionPlan } from '../../seeds/n8n-provision-plan';

describe('managed n8n ACP provision plan', () => {
  it('bleibt ohne verwalteten n8n-Host inaktiv', () => {
    expect(buildManagedN8nProvisionPlan({})).toBeNull();
  });

  it('leitet öffentliche und interne Compose-Adressen deterministisch ab', () => {
    expect(
      buildManagedN8nProvisionPlan({
        N8N_HOST: 'N8N.Example.DE',
        N8N_WEBHOOK_URL: 'https://n8n.example.de/',
        TENANT_SLUG: 'Kanzlei-Nord',
      }),
    ).toEqual({
      tenantSlug: 'kanzlei-nord',
      uiBaseUrl: 'https://n8n.example.de',
      apiBaseUrl: 'http://n8n:5678/api/v1',
      webhookBaseUrl: 'http://n8n:5678/webhook',
      callbackBaseUrl: 'http://app:3000',
    });
  });

  it('lehnt HTTP und widersprüchliche Hosts ab', () => {
    expect(() =>
      buildManagedN8nProvisionPlan({
        N8N_HOST: 'n8n.example.de',
        N8N_WEBHOOK_URL: 'http://n8n.example.de/',
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      buildManagedN8nProvisionPlan({
        N8N_HOST: 'n8n.example.de',
        N8N_WEBHOOK_URL: 'https://other.example.de/',
      }),
    ).toThrow(/unterschiedliche Hosts/);
  });
});
