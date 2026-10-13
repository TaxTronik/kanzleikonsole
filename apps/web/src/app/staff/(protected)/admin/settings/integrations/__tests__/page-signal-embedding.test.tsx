// @vitest-environment jsdom
// Integrationsseite: Signal-Embedding-Status nur bei aktivem Modul und
// erreichbarer Engine laden (B-08, Welle 15, ersetzt die Quelltextprüfung aus
// signal-embedding-card-structure.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({
  modules: { signalEngine: true } as Record<string, boolean>,
  signalEngine: { ok: true } as { ok: boolean } | null,
  config: {
    riskLayerConfig: { url: 'http://signal:8000', operatorToken: 'op' } as null | {
      url: string;
      operatorToken?: string;
    },
  },
  embeddingStatus: vi.fn(),
  warn: vi.fn(),
  cards: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['ADMIN'] },
  })),
}));
vi.mock('@taxtronik/config', () => ({
  env: {
    S3_ENDPOINT: 'http://minio:9000',
    REDIS_URL: 'redis://redis:6379',
    CLAMAV_HOST: 'clamav',
    CLAMAV_PORT: 3310,
    NEXTAUTH_URL: 'https://kanzlei.example',
    AUTH_SECRET: 'x'.repeat(32),
  },
  get riskLayerConfig() {
    return h.config.riskLayerConfig;
  },
}));
vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: class {
    embeddingStatus = h.embeddingStatus;
  },
}));
vi.mock('@/server/settings/smtp', () => ({
  getSmtpStatus: vi.fn(async () => ({ fromDb: false })),
}));
vi.mock('@/server/health/checks', () => ({
  checkPostgres: vi.fn(async () => ({ ok: true })),
  checkRedis: vi.fn(async () => ({ ok: true })),
  checkObjectStore: vi.fn(async () => ({ ok: true })),
  checkClamAV: vi.fn(async () => ({ ok: true })),
  checkN8nForTenant: vi.fn(async () => ({ ok: false, url: null, source: 'none' })),
  checkTsaForTenant: vi.fn(async () => ({ ok: true, url: null, source: 'none' })),
  checkSignalEngine: vi.fn(async () => h.signalEngine),
}));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn(async () => h.modules) }));
vi.mock('@/server/logger', () => ({ log: { warn: h.warn } }));
vi.mock('../signal-embedding-card', () => ({
  SignalEmbeddingCard: (props: Record<string, unknown>) => {
    h.cards.push(props);
    return null;
  },
}));

import IntegrationsSettingsPage from '../page';

const STATUS = { ok: true, engineVersion: '0.1.0' };

async function renderPage() {
  return renderServer(IntegrationsSettingsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cards.length = 0;
  h.modules = { signalEngine: true };
  h.signalEngine = { ok: true };
  h.config.riskLayerConfig = { url: 'http://signal:8000', operatorToken: 'op' };
  h.embeddingStatus.mockResolvedValue(STATUS);
});

describe('Integrationsseite: Signal-Embedding', () => {
  it('lädt und zeigt den Status bei aktivem Modul und erreichbarer Engine', async () => {
    await renderPage();
    expect(h.embeddingStatus).toHaveBeenCalledOnce();
    expect(h.cards).toEqual([
      { status: STATUS, statusUnavailable: false, operatorConfigured: true },
    ]);
  });

  it('zeigt die Karte ohne Signal-Modul gar nicht und fragt die Engine nicht', async () => {
    h.modules = { signalEngine: false };
    await renderPage();
    expect(h.embeddingStatus).not.toHaveBeenCalled();
    expect(h.cards).toEqual([]);
  });

  it.each([
    ['nicht erreichbarer Engine', () => (h.signalEngine = { ok: false })],
    ['fehlendem Health-Ergebnis', () => (h.signalEngine = null)],
    ['fehlender Konfiguration', () => (h.config.riskLayerConfig = null)],
  ])('meldet den Status bei %s als nicht verfügbar, ohne ihn zu laden', async (_case, arrange) => {
    arrange();
    await renderPage();
    expect(h.embeddingStatus).not.toHaveBeenCalled();
    expect(h.cards).toEqual([expect.objectContaining({ status: null, statusUnavailable: true })]);
  });

  it('bleibt bei einem Fehler der Engine erreichbar und protokolliert nur serverseitig', async () => {
    h.embeddingStatus.mockRejectedValueOnce(new Error('ECONNRESET signal:8000'));
    await renderPage();
    expect(h.cards).toEqual([expect.objectContaining({ status: null, statusUnavailable: true })]);
    expect(h.warn).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('ECONNRESET');
  });
});
