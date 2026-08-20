import { describe, expect, it } from 'vitest';
import {
  buildManagedN8nEndpointRepair,
  buildManagedN8nProvisionPlan,
  buildManagedN8nProvisionRepair,
} from '../../seeds/n8n-provision-plan';

describe('managed n8n ACP provision plan', () => {
  it('bleibt ohne verwalteten n8n-Host inaktiv', () => {
    expect(buildManagedN8nProvisionPlan({})).toBeNull();
  });

  it('leitet die sichtbaren n8n-Adressen aus der öffentlichen Domain ab', () => {
    expect(
      buildManagedN8nProvisionPlan({
        N8N_HOST: 'N8N.Example.DE',
        N8N_WEBHOOK_URL: 'https://n8n.example.de/',
        TENANT_SLUG: 'Kanzlei-Nord',
      }),
    ).toEqual({
      tenantSlug: 'kanzlei-nord',
      uiBaseUrl: 'https://n8n.example.de',
      apiBaseUrl: 'https://n8n.example.de/api/v1',
      webhookBaseUrl: 'https://n8n.example.de/webhook',
      callbackBaseUrl: 'http://app:3000',
    });
  });

  it('repariert bei Updates nur die früher automatisch gesetzten Compose-Adressen', () => {
    const plan = buildManagedN8nProvisionPlan({
      N8N_HOST: 'n8n.example.de',
      N8N_WEBHOOK_URL: 'https://n8n.example.de/',
    });
    expect(plan).not.toBeNull();

    expect(
      buildManagedN8nProvisionRepair(plan!, {
        kind: 'BUNDLED',
        apiBaseUrl: 'http://n8n:5678/api/v1',
        webhookBaseUrl: 'http://n8n:5678/webhook',
      }),
    ).toEqual({
      apiBaseUrl: 'https://n8n.example.de/api/v1',
      webhookBaseUrl: 'https://n8n.example.de/webhook',
    });
  });

  it('überschreibt weder manuelle noch externe n8n-Adressen', () => {
    const plan = buildManagedN8nProvisionPlan({ N8N_HOST: 'n8n.example.de' });
    expect(plan).not.toBeNull();

    expect(
      buildManagedN8nProvisionRepair(plan!, {
        kind: 'BUNDLED',
        apiBaseUrl: 'https://internal.example.de/api/v1',
        webhookBaseUrl: 'https://internal.example.de/webhook',
      }),
    ).toBeNull();
    expect(
      buildManagedN8nProvisionRepair(plan!, {
        kind: 'SELF_HOSTED',
        apiBaseUrl: 'http://n8n:5678/api/v1',
        webhookBaseUrl: 'http://n8n:5678/webhook',
      }),
    ).toBeNull();
  });

  it('zieht bereits erkannte verwaltete Workflow-Routen auf die öffentliche Domain nach', () => {
    const plan = buildManagedN8nProvisionPlan({ N8N_HOST: 'n8n.example.de' });
    expect(plan).not.toBeNull();

    expect(
      buildManagedN8nEndpointRepair(plan!, {
        source: 'DISCOVERED',
        productionUrl: 'http://n8n:5678/webhook/research?tenant=nord',
        testUrl: 'http://n8n:5678/webhook-test/research',
      }),
    ).toEqual({
      productionUrl: 'https://n8n.example.de/webhook/research?tenant=nord',
      testUrl: 'https://n8n.example.de/webhook-test/research',
    });
  });

  it('lässt eigene und bereits öffentliche Workflow-Routen unverändert', () => {
    const plan = buildManagedN8nProvisionPlan({ N8N_HOST: 'n8n.example.de' });
    expect(plan).not.toBeNull();

    expect(
      buildManagedN8nEndpointRepair(plan!, {
        source: 'CUSTOM',
        productionUrl: 'http://n8n:5678/webhook/custom',
        testUrl: null,
      }),
    ).toBeNull();
    expect(
      buildManagedN8nEndpointRepair(plan!, {
        source: 'MANAGED',
        productionUrl: 'https://n8n.example.de/webhook/managed',
        testUrl: null,
      }),
    ).toBeNull();
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
