import { describe, expect, it } from 'vitest';
import { presentN8nHealth } from '../presentation';

describe('presentN8nHealth', () => {
  it('zeigt eine alte Loopback-Vorgabe als Migration statt als Host-Fehler', () => {
    const result = presentN8nHealth({
      ok: false,
      url: 'http://localhost:5678/webhook',
      source: 'env',
      legacyMigrationRequired: true,
    });

    expect(result).toMatchObject({
      endpoint: 'Legacy-Vorgabe: http://localhost:5678/webhook',
      status: {
        attention: true,
        label: 'Migration nötig',
        reason: expect.stringContaining('konkrete Workflow-URLs'),
      },
      action: {
        href: '/staff/admin/settings/n8n',
        label: 'Legacy-Konfiguration migrieren',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private/reservierte Adresse');
  });

  it('behält echte Fehler einer normalisierten Verbindung bei', () => {
    const result = presentN8nHealth({
      ok: false,
      url: 'https://n8n.example.test/api/v1',
      source: 'tenant',
      error: 'HTTP 503',
    });

    expect(result.status).toEqual({
      ok: false,
      url: 'https://n8n.example.test/api/v1',
      source: 'tenant',
      error: 'HTTP 503',
    });
    expect(result.action.label).toBe('n8n verwalten');
  });
});
