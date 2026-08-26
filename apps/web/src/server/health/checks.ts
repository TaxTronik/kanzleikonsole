// =============================================================================
// Wiederverwendbare Health-Checks für externe Dienste
//
// Werden vom `/api/health`-Endpoint UND von der Admin-Integrationen-Seite
// benutzt. Tot­es bleibt nicht ablesbar getrennt — wenn neue Dienste dazu­
// kommen, an EINER Stelle ergänzen.
// =============================================================================

import { prisma, withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { createConnection } from 'node:net';
import { env, riskLayerConfig } from '@taxtronik/config';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { createRfc3161Adapter, resolveTsaUrl } from '@taxtronik/evidence';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import { randomBytes } from 'node:crypto';
import { safeFetchN8n } from '@/server/http/ssrf-guard';

export interface ServiceStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface N8nTenantStatus extends ServiceStatus {
  url: string | null;
  source: 'tenant' | 'legacy-setting' | 'env' | 'none';
  /** Eine alte Loopback-Vorgabe ist im App-Container kein erreichbares n8n-Ziel. */
  legacyMigrationRequired?: true;
}

export async function checkPostgres(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function checkRedis(): Promise<ServiceStatus> {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(env.REDIS_URL);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) || 6379 }, () => {
      socket.destroy();
      resolve({ ok: true, latencyMs: Date.now() - start });
    });
    socket.on('error', (e) => resolve({ ok: false, error: e.message }));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
  });
}

/**
 * S3-kompatibler Object-Store (SeaweedFS in unserem Setup, kann aber auch
 * AWS S3 sein) — ListBuckets als Liveness-Probe.
 */
export async function checkObjectStore(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      forcePathStyle: true,
    });
    await client.send(new ListBucketsCommand({}));
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function checkClamAV(): Promise<ServiceStatus> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT }, () => {
      socket.write('PING\n');
    });
    let response = '';
    socket.on('data', (d: Buffer) => {
      response += d.toString();
      if (response.includes('PONG')) {
        socket.destroy();
        resolve({ ok: true, latencyMs: Date.now() - start });
      }
    });
    socket.on('error', (e) => resolve({ ok: false, error: e.message }));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
  });
}

export async function checkN8n(): Promise<ServiceStatus> {
  return checkN8nUrl(env.N8N_WEBHOOK_BASE_URL ?? null);
}

/** Tenant-spezifisch: bevorzugt die normalisierte n8n-Verbindung. */
export async function checkN8nForTenant(tenantId: string): Promise<N8nTenantStatus> {
  const stored = await withTenantContext(
    { tenantId, actorId: null, actorType: 'SYSTEM' },
    async (tx) => {
      const connection = await tx.n8nConnection.findUnique({
        where: { tenantId },
        select: {
          enabled: true,
          routingMode: true,
          uiBaseUrl: true,
          apiBaseUrl: true,
          webhookBaseUrl: true,
          endpoints: {
            where: { enabled: true },
            orderBy: { name: 'asc' },
            take: 1,
            select: { productionUrl: true },
          },
        },
      });
      if (connection) return { connection, legacyUrl: '' };
      const value = await readTenantSettingValue(tx, tenantId, 'integrations.n8n');
      return {
        connection: null,
        legacyUrl:
          value === undefined ? '' : ((value as { webhookBaseUrl?: string }).webhookBaseUrl ?? ''),
      };
    },
  );
  if (stored.connection) {
    // Die UI-Adresse ist ausschließlich ein Browser-Link. Für den
    // serverseitigen Healthcheck verwenden wir nur Ziele, die TaxTronik selbst
    // anspricht; dadurch wird eine reine UI-URL nie zum SSRF-/Health-Ziel.
    const connectionUrl =
      stored.connection.apiBaseUrl ??
      stored.connection.webhookBaseUrl ??
      stored.connection.endpoints[0]?.productionUrl ??
      '';
    if (!stored.connection.enabled || stored.connection.routingMode === 'DISABLED') {
      return {
        ok: false,
        url: connectionUrl || null,
        source: 'tenant',
        error: 'n8n-Integration bewusst deaktiviert',
      };
    }
    if (!connectionUrl) {
      return {
        ok: false,
        url: null,
        source: 'tenant',
        error: 'Keine n8n-Instanz-URL gespeichert',
      };
    }
    const result = await checkN8nUrl(connectionUrl);
    return { ...result, url: connectionUrl, source: 'tenant' };
  }

  const dbUrl = stored.legacyUrl;
  if (dbUrl) {
    return checkLegacyN8nUrl(dbUrl, 'legacy-setting');
  }
  if (env.N8N_WEBHOOK_BASE_URL) {
    return checkLegacyN8nUrl(env.N8N_WEBHOOK_BASE_URL, 'env');
  }
  return { ok: false, url: null, source: 'none', error: 'Keine n8n-Webhook-URL gesetzt' };
}

async function checkLegacyN8nUrl(
  rawUrl: string,
  source: 'legacy-setting' | 'env',
): Promise<N8nTenantStatus> {
  // Alte Installationen haben häufig `localhost` gespeichert. Aus dem
  // App-Container zeigt das auf den App-Container selbst, nicht auf n8n. Das
  // ist ein Konfigurations-/Migrationszustand und kein sinnvoller
  // Erreichbarkeitstest. Insbesondere wird der SSRF-Guard hier nicht umgangen:
  // Wir starten für diese URL gar keinen Request. Normalisierte Verbindungen
  // laufen weiterhin ausnahmslos durch safeFetch.
  if (isLoopbackUrl(rawUrl)) {
    return {
      ok: false,
      url: rawUrl,
      source,
      legacyMigrationRequired: true,
    };
  }

  const result = await checkN8nUrl(rawUrl);
  return { ...result, url: rawUrl, source };
}

async function checkN8nUrl(rawUrl: string | null): Promise<ServiceStatus> {
  if (!rawUrl) return { ok: false, error: 'n8n-URL nicht gesetzt' };
  const start = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL('/healthz', rawUrl);
    const ctrl = new AbortController();
    timeout = setTimeout(() => ctrl.abort(), 3000);
    // R1/H1: safeFetch macht assertPublicHost + DNS-Pinning in einem Schritt —
    // kein TOCTOU-Fenster zwischen Check und Verbindung.
    // M-6: redirect:'error' verhindert 302 zu internen Adressen.
    const res = await safeFetchN8n(url.toString(), 'health', {
      signal: ctrl.signal,
      redirect: 'error',
    });
    await res.text(); // Body konsumieren, damit safeFetch seinen gepinnten Agent schließt.
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Signal-Engine (optionales Modul): Bearer-authentifizierter Liveness-Ping auf
 * den internen Engine-Host (`GET /v1/health`, wie der Risk-Layer). Gibt `null`
 * zurück, wenn die Engine nicht konfiguriert ist (riskLayerConfig === null);
 * der Aufrufer entscheidet dann, ob die Zeile als „nicht konfiguriert" erscheint.
 */
export async function checkSignalEngine(): Promise<ServiceStatus | null> {
  if (!riskLayerConfig) return null;
  const start = Date.now();
  try {
    // RISK_LAYER_URL ist Operator-ENV und darf bewusst 127.0.0.1, Docker-DNS
    // oder private LAN-IPs nutzen. Deshalb derselbe trusted Transport wie beim
    // Subsumtions-/Risk-Layer statt des öffentlichen SSRF-Guards.
    const health = await new RiskLayerClient({ config: riskLayerConfig }).health();
    if ((health as { ok?: unknown }).ok === false) {
      return { ok: false, error: 'Engine meldet ok=false' };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: formatSignalEngineError(e) };
  }
}

function formatSignalEngineError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = errorCauseCode(e);

  if (
    e.name === 'AbortError' ||
    e.name === 'TimeoutError' ||
    e.message.includes('timed out') ||
    e.message.includes('The operation was aborted')
  ) {
    return 'Signal-Engine hat nicht rechtzeitig geantwortet. Bitte Engine-Status und Logs pruefen.';
  }

  if (e.message === 'fetch failed' || code) {
    const codeSuffix = code ? ` (${code})` : '';
    if (riskLayerConfig && isLoopbackUrl(riskLayerConfig.url)) {
      const host = new URL(riskLayerConfig.url).host;
      return (
        `Signal-Engine nicht erreichbar${codeSuffix}. RISK_LAYER_URL zeigt auf ${host}; ` +
        'in einem Docker-Container meint 127.0.0.1/localhost den App-Container. ' +
        'Im Compose-Stack http://risk-layer:8000 oder eine vom App-Container erreichbare interne Adresse nutzen.'
      );
    }
    return (
      `Signal-Engine nicht erreichbar${codeSuffix}. ` +
      'Pruefe Container, RISK_LAYER_URL und Bearer-Token.'
    );
  }

  return e.message;
}

function errorCauseCode(e: Error): string | null {
  const cause = (e as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.startsWith('127.')
    );
  } catch {
    return false;
  }
}

export interface TsaCheck extends ServiceStatus {
  url?: string | null;
  source?: 'tenant' | 'env' | 'default';
}

const DEFAULT_TSA_URL = resolveTsaUrl('globalsign', null);

/**
 * Generischer ENV-only-Check (genutzt vom /api/health-Endpoint, der keinen
 * Tenant-Kontext hat). Pro-Tenant-Check via `checkTsaForTenant`.
 */
export async function checkTsa(): Promise<TsaCheck> {
  const envUrl = env.TIMESTAMP_AUTHORITY_URL?.trim();
  if (envUrl) return roundtripTsa(envUrl, 'env');
  if (!DEFAULT_TSA_URL) throw new Error('GlobalSign-TSA-Preset fehlt.');
  return roundtripTsa(DEFAULT_TSA_URL, 'default');
}

/**
 * Tenant-spezifischer TSA-Check: bevorzugt `tenant_setting.evidence.tsa`,
 * fällt sonst auf ENV und danach auf den verifizierten GlobalSign-Default
 * zurück. Macht einen echten
 * RFC-3161-Roundtrip — sieht also auch, wenn der Server zwar erreichbar ist,
 * aber keinen granted UND gegen Hash/Trust-Roots verifizierbaren Response liefert.
 */
export async function checkTsaForTenant(tenantId: string): Promise<TsaCheck> {
  // RLS-Backstop: tenant_setting ist mandantenscharf — Read über
  // withTenantContext, sonst gibt die App-Verbindung keine Zeilen aus.
  const value = await withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
    readTenantSettingValue(tx, tenantId, 'evidence.tsa'),
  );
  if (value !== undefined) {
    const v = value as { providerId?: string; customUrl?: string };
    const url = resolveTsaUrl(v.providerId ?? null, v.customUrl ?? null);
    if (url) return roundtripTsa(url, 'tenant');
  }
  const envUrl = env.TIMESTAMP_AUTHORITY_URL?.trim();
  if (envUrl) return roundtripTsa(envUrl, 'env');
  if (!DEFAULT_TSA_URL) throw new Error('GlobalSign-TSA-Preset fehlt.');
  return roundtripTsa(DEFAULT_TSA_URL, 'default');
}

async function roundtripTsa(url: string, source: 'tenant' | 'env' | 'default'): Promise<TsaCheck> {
  const start = Date.now();
  try {
    // SSRF: kein separater Pre-Check mehr nötig — der RFC-3161-Adapter geht über
    // safeFetch, das die (DB-konfigurierte) TSA-URL genau EINMAL auflöst, jede
    // IP gegen die Block-Listen prüft und die Connection auf die geprüfte
    // Adresse pinnt. Ein vorgelagertes assertPublicHost hätte nur einen zweiten,
    // unabhängigen DNS-Lookup erzeugt (TOCTOU-Fenster) ohne Schutzgewinn.
    // Die Factory bindet zusaetzlich die operatorseitig hinterlegten Roots ein;
    // der nackte Konstruktor wuerde nur dem eingebetteten GlobalSign-Root trauen.
    const adapter = createRfc3161Adapter(url, 5_000);
    const payload = randomBytes(32);
    const stamp = await adapter.timestamp(payload);
    const response = stamp.tsaResponseBlob ? Buffer.from(stamp.tsaResponseBlob) : null;
    if (!(await adapter.verify(payload, response))) {
      throw new Error(
        'TSA-Antwort ist nicht an den Test-Hash oder an einen konfigurierten Trust-Anchor gebunden.',
      );
    }
    return { ok: true, latencyMs: Date.now() - start, url, source };
  } catch (e) {
    return { ok: false, error: (e as Error).message, url, source };
  }
}
