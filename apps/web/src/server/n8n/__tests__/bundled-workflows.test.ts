import { describe, expect, it } from 'vitest';
import {
  BUNDLED_N8N_WORKFLOWS,
  bindN8nHeaderCredential,
  DEFAULT_GWG_OFFICER_EMAIL,
  materializeBundledN8nWorkflow,
  unresolvedBundledN8nPlaceholders,
} from '../bundled-workflows';

const VALUES = {
  taxtronikApiUrl: 'https://kanzlei.example.test',
  callbackKeyId: '00000000-0000-4000-8000-000000000010',
  smtpFrom: 'Kanzlei Test <kanzlei@example.test>',
  gwgOfficerEmail: 'gwg@example.test',
};

describe('gebündelte n8n-Workflows', () => {
  it('materialisiert alle nicht-geheimen Importwerte ohne Rest-Platzhalter', () => {
    for (const template of BUNDLED_N8N_WORKFLOWS) {
      const result = materializeBundledN8nWorkflow(template.workflow, VALUES);
      const serialized = JSON.stringify(result);

      expect(unresolvedBundledN8nPlaceholders(result), template.templateId).toEqual([]);
      expect(serialized, template.templateId).not.toContain('$vars');
      expect(serialized, template.templateId).not.toContain('$env');
    }
  });

  it('setzt API-URL und Callback-Key in callbackfähige Vorlagen ein', () => {
    for (const template of BUNDLED_N8N_WORKFLOWS.filter(
      (entry) => entry.callbackScopes.length > 0,
    )) {
      const result = materializeBundledN8nWorkflow(template.workflow, VALUES);
      const serialized = JSON.stringify(result);
      expect(serialized, template.templateId).toContain(VALUES.taxtronikApiUrl);
      expect(serialized, template.templateId).toContain(VALUES.callbackKeyId);
    }
  });

  it('mutiert die eingecheckten Vorlagen beim Materialisieren nicht', () => {
    const template = BUNDLED_N8N_WORKFLOWS.find(
      (entry) => entry.templateId === 'taxtronik.gwg-expiry-check',
    )!;
    const before = JSON.stringify(template.workflow);

    materializeBundledN8nWorkflow(template.workflow, VALUES);

    expect(JSON.stringify(template.workflow)).toBe(before);
    expect(before).toContain('__GWG_OFFICER_EMAIL__');
  });

  it('materialisiert einen sicheren GwG-Platzhalter und bindet nur Header-Auth-Nodes', () => {
    const template = BUNDLED_N8N_WORKFLOWS.find(
      (entry) => entry.templateId === 'taxtronik.gwg-expiry-check',
    )!;
    const materialized = materializeBundledN8nWorkflow(template.workflow, {
      ...VALUES,
      gwgOfficerEmail: DEFAULT_GWG_OFFICER_EMAIL,
    });
    const bound = bindN8nHeaderCredential(materialized, {
      id: 'credential-1',
      name: 'TaxTronik Rückkanal',
      type: 'httpHeaderAuth',
    });
    const serialized = JSON.stringify(bound);

    expect(serialized).toContain(DEFAULT_GWG_OFFICER_EMAIL);
    expect(serialized).toContain(
      '"httpHeaderAuth":{"id":"credential-1","name":"TaxTronik Rückkanal"}',
    );
    expect(JSON.stringify(template.workflow)).not.toContain('credential-1');
  });

  it('lässt Workflows ohne Header-Auth-Nodes beim Binden unverändert', () => {
    const template = BUNDLED_N8N_WORKFLOWS.find(
      (entry) => entry.templateId === 'taxtronik.connection-test',
    )!;
    const materialized = materializeBundledN8nWorkflow(template.workflow, VALUES);
    expect(
      bindN8nHeaderCredential(materialized, {
        id: 'credential-1',
        name: 'TaxTronik Rückkanal',
        type: 'httpHeaderAuth',
      }),
    ).toEqual(materialized);
  });
});
