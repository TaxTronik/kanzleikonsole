import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock('@taxtronik/config', () => ({ env: { N8N_LEGACY_CALLBACKS_ENABLED: true } }));
vi.mock('@/server/logger', () => ({ log: { warn: warnMock } }));

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app');
const ROUTES = [
  'expiring-gwg-checks',
  'overdue-requests',
  'request-detail',
  'request-inbound',
  'research-result',
] as const;

async function freshModule() {
  vi.resetModules();
  return import('../legacy-access');
}

beforeEach(() => {
  warnMock.mockClear();
});

describe('Deprecation-Signal der Legacy-n8n-Callbacks', () => {
  it('warnt je Route und Prozess genau einmal mit dem v1-Nachfolger', async () => {
    const { reportLegacyN8nCallbackUse } = await freshModule();

    reportLegacyN8nCallbackUse('overdue-requests');
    reportLegacyN8nCallbackUse('overdue-requests');
    reportLegacyN8nCallbackUse('request-detail');
    reportLegacyN8nCallbackUse('overdue-requests');

    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock.mock.calls.map(([fields]) => fields)).toEqual([
      {
        component: 'n8n-legacy',
        route: '/api/n8n/overdue-requests',
        replacement: '/api/integrations/n8n/v1/overdue-requests',
      },
      {
        component: 'n8n-legacy',
        route: '/api/n8n/request-detail/[id]',
        replacement: '/api/integrations/n8n/v1/request-detail/[id]',
      },
    ]);
  });

  it('meldet nach einem Neustart erneut', async () => {
    (await freshModule()).reportLegacyN8nCallbackUse('research-result');
    (await freshModule()).reportLegacyN8nCallbackUse('research-result');

    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('nennt für jede Route existierende Legacy- und v1-Handler', async () => {
    const { reportLegacyN8nCallbackUse } = await freshModule();

    for (const route of ROUTES) reportLegacyN8nCallbackUse(route);

    expect(warnMock).toHaveBeenCalledTimes(ROUTES.length);
    for (const [fields] of warnMock.mock.calls) {
      for (const path of [fields.route, fields.replacement]) {
        expect(existsSync(join(APP_DIR, path, 'route.ts')), path).toBe(true);
      }
    }
  });
});
