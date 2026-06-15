// =============================================================================
// Wiederverwendbare Health-Checks für externe Dienste
//
// Werden vom `/api/health`-Endpoint UND von der Admin-Integrationen-Seite
// benutzt. Tot­es bleibt nicht ablesbar getrennt — wenn neue Dienste dazu­
// kommen, an EINER Stelle ergänzen.
// =============================================================================

import { prisma, withTenantContext } from '@taxtronik/db';
import { createConnection } from 'node:net';
import { env, riskLayerConfig } from '@taxtronik/config';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { Rfc3161HttpAdapter, resolveTsaUrl } from '@taxtronik/evidence';
import { randomBytes } from 'node:crypto';
import { safeFetch } from '@/server/http/ssrf-guard';

export interface ServiceStatus {
  ok: boolean;
  latencyMs?: number;
  error?: string;
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
    const socket = createConnection(
      { host: url.hostname, port: Number(url.port) || 6379 },
      () => {
        socket.destroy();
        resolve({ ok: true, latencyMs: Date.now() - start });
      },
    );
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
    const socket = createConnection(
      { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT },
      () => {
        socket.write('PING\n');
      },
    );
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

/** Tenant-spezifisch: nimmt die URL aus `tenant_setting.integrations.n8n`. */
export async function checkN8nForTenant(tenantId: string): Promise<ServiceStatus & { url?: string | null; source?: 'tenant' | 'env' | 'none' }> {
  const row = await withTenantContext(
    { tenantId, actorId: null, actorType: 'SYSTEM' },
    (tx) =>
      tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: 'integrations.n8n' } },
        select: { value: true },
      }),
  );
  const dbUrl = row ? ((row.value as { webhookBaseUrl?: string }).webhookBaseUrl ?? '') : '';
  if (dbUrl) {
    const r = await checkN8nUrl(dbUrl);
    return { ...r, url: dbUrl, source: 'tenant' };
  }
  if (env.N8N_WEBHOOK_BASE_URL) {
    const r = await checkN8nUrl(env.N8N_WEBHOOK_BASE_URL);
    return { ...r, url: env.N8N_WEBHOOK_BASE_URL, source: 'env' };
  }
  return { ok: false, url: null, source: 'none', error: 'Keine n8n-Webhook-URL gesetzt' };
}

async function checkN8nUrl(rawUrl: string | null): Promise<ServiceStatus> {
  if (!rawUrl) return { ok: false, error: 'n8n-URL nicht gesetzt' };
  const start = Date.now();
  try {
    const url = new URL('/healthz', rawUrl);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    // R1/H1: safeFetch macht assertPublicHost + DNS-Pinning in einem Schritt —
    // kein TOCTOU-Fenster zwischen Check und Verbindung.
    // M-6: redirect:'error' verhindert 302 zu internen Adressen.
    const res = await safeFetch(url.toString(), { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(to);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
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
    const url = new URL('/v1/health', riskLayerConfig.url);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    // safeFetch macht assertPublicHost + DNS-Pinning in einem Schritt (der interne
    // Host muss in INTERNAL_FETCH_HOSTS stehen); redirect:'error' gegen 302→intern.
    const res = await safeFetch(url.toString(), {
      headers: { Authorization: `Bearer ${riskLayerConfig.token}` },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(to);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface TsaCheck extends ServiceStatus {
  url?: string | null;
  source?: 'tenant' | 'env' | 'none';
}

/**
 * Generischer ENV-only-Check (genutzt vom /api/health-Endpoint, der keinen
 * Tenant-Kontext hat). Pro-Tenant-Check via `checkTsaForTenant`.
 */
export async function checkTsa(): Promise<TsaCheck> {
  if (!env.TIMESTAMP_AUTHORITY_URL) {
    return {
      ok: false,
      source: 'none',
      error: 'TIMESTAMP_AUTHORITY_URL leer — lokaler Self-Timestamp aktiv',
    };
  }
  return roundtripTsa(env.TIMESTAMP_AUTHORITY_URL, 'env');
}

/**
 * Tenant-spezifischer TSA-Check: bevorzugt `tenant_setting.evidence.tsa`,
 * fällt sonst auf ENV zurück, sonst keine TSA. Macht einen echten
 * RFC-3161-Roundtrip — sieht also auch, wenn der Server zwar erreichbar ist,
 * aber kein granted Response liefert.
 */
export async function checkTsaForTenant(tenantId: string): Promise<TsaCheck> {
  // RLS-Backstop: tenant_setting ist mandantenscharf — Read über
  // withTenantContext, sonst gibt die App-Verbindung keine Zeilen aus.
  const row = await withTenantContext(
    { tenantId, actorId: null, actorType: 'SYSTEM' },
    (tx) =>
      tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: 'evidence.tsa' } },
        select: { value: true },
      }),
  );
  if (row) {
    const v = row.value as { providerId?: string; customUrl?: string };
    const url = resolveTsaUrl(v.providerId ?? null, v.customUrl ?? null);
    if (url) return roundtripTsa(url, 'tenant');
  }
  if (env.TIMESTAMP_AUTHORITY_URL) {
    return roundtripTsa(env.TIMESTAMP_AUTHORITY_URL, 'env');
  }
  return {
    ok: false,
    source: 'none',
    error: 'Kein externer TSA — lokaler Self-Timestamp aktiv',
  };
}

async function roundtripTsa(url: string, source: 'tenant' | 'env'): Promise<TsaCheck> {
  const start = Date.now();
  try {
    // SSRF: kein separater Pre-Check mehr nötig — Rfc3161HttpAdapter geht über
    // safeFetch, das die (DB-konfigurierte) TSA-URL genau EINMAL auflöst, jede
    // IP gegen die Block-Listen prüft und die Connection auf die geprüfte
    // Adresse pinnt. Ein vorgelagertes assertPublicHost hätte nur einen zweiten,
    // unabhängigen DNS-Lookup erzeugt (TOCTOU-Fenster) ohne Schutzgewinn.
    const adapter = new Rfc3161HttpAdapter(url, 5_000);
    await adapter.timestamp(randomBytes(32));
    return { ok: true, latencyMs: Date.now() - start, url, source };
  } catch (e) {
    return { ok: false, error: (e as Error).message, url, source };
  }
}
