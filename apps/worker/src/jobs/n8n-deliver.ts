// =============================================================================
// n8n-Deliver-Worker (S15)
//
// Liest eine PENDING-Reihe aus `n8n_outbox`, postet sie an n8n und markiert
// sie als DELIVERED. Bei Fehlern wird der Job neu eingereiht (BullMQ Retry mit
// Exponential-Backoff). Nach Ausschöpfen aller Versuche: status=FAILED, Reihe
// bleibt zur Ops-Inspektion erhalten.
//
// Eigenständig im Worker (keine @taxtronik/web-Imports): liest tenant_setting
// direkt und entschlüsselt das HMAC-Secret inline mit AES-256-GCM aus
// AUTH_SECRET — symmetrisch zur Web-Implementierung in
// apps/web/src/server/crypto/secret-box.ts.
// =============================================================================

import { Worker, Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { isAllowedN8nEvent, signOutboundN8n } from '@taxtronik/n8n-shared';
// M-7: shared crypto — keine Duplikation mehr von secret-box.
import { decryptSecret, looksEncrypted } from '@taxtronik/crypto';
import { connection, type N8nDeliverJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { safeFetch, SsrfGuardError } from '@taxtronik/http-utils';

// -----------------------------------------------------------------------------
// n8n-Config-Lookup
// -----------------------------------------------------------------------------

interface N8nConfig {
  webhookBaseUrl: string;
  hmacSecret: string;
}

interface N8nStored {
  webhookBaseUrl?: string;
  hmacEncrypted?: string;
  hmacSecret?: string; // legacy/plain-text-Fallback
}

async function resolveN8nConfig(tenantId: string | null): Promise<N8nConfig> {
  if (tenantId) {
    const row = await prismaOwner.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'integrations.n8n' } },
      select: { value: true },
    });
    if (row) {
      const v = row.value as N8nStored;
      let hmac = '';
      if (v.hmacEncrypted && looksEncrypted(v.hmacEncrypted)) {
        try { hmac = decryptSecret(v.hmacEncrypted); } catch { hmac = ''; }
      } else if (typeof v.hmacSecret === 'string') {
        hmac = v.hmacSecret;
      }
      if (v.webhookBaseUrl && hmac) {
        return { webhookBaseUrl: v.webhookBaseUrl, hmacSecret: hmac };
      }
    }
  }
  // ENV-Fallback (Single-Tenant)
  return {
    webhookBaseUrl: env.N8N_WEBHOOK_BASE_URL ?? '',
    hmacSecret: env.N8N_HMAC_SECRET ?? '',
  };
}

// Konsolidierung Round 12: HMAC + Whitelist liegen in @taxtronik/n8n-shared.
// Vorher duplizierte der Worker beides inline; Drift-Klasse beseitigt.

async function deliver(outboxId: string): Promise<void> {
  const row = await prismaOwner.n8nOutbox.findUnique({ where: { id: outboxId } });
  if (!row) {
    log.warn({ outboxId }, 'n8n-deliver: outbox row not found, skipping');
    return;
  }
  if (row.status === 'DELIVERED') {
    log.debug({ outboxId }, 'n8n-deliver: already delivered, skipping');
    return;
  }
  if (!isAllowedN8nEvent(row.event)) {
    log.error({ outboxId, event: row.event }, 'n8n-deliver: event not in whitelist, marking FAILED');
    await prismaOwner.n8nOutbox.update({
      where: { id: outboxId },
      data: { status: 'FAILED', lastError: `Event '${row.event}' nicht in Whitelist.` },
    });
    return;
  }

  await prismaOwner.n8nOutbox.update({
    where: { id: outboxId },
    data: { attempts: { increment: 1 } },
  });

  const cfg = await resolveN8nConfig(row.tenantId);
  if (!cfg.webhookBaseUrl || !cfg.hmacSecret) {
    // n8n nicht konfiguriert — kein Retry, als DELIVERED markieren (silent skip,
    // analog zur alten fire-and-forget-Semantik).
    await prismaOwner.n8nOutbox.update({
      where: { id: outboxId },
      data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: 'n8n nicht konfiguriert (silent skip)' },
    });
    return;
  }

  // N7: row.event ist whitelisted (isAllowedEvent), aber ein direkter DB-
  // Manipulator könnte exotische Zeichen einschleusen — Defense in Depth via
  // encodeURIComponent. `.`/`-`/`_` bleiben dabei unverändert (RFC 3986
  // unreserved), Subpath-Trennung kann der Wert damit garantiert nicht mehr.
  const url = `${cfg.webhookBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(row.event)}`;

  const body = JSON.stringify({
    event: row.event,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    tenantId: row.tenantId,
  });
  const { signature, timestamp, nonce } = signOutboundN8n(row.event, body, cfg.hmacSecret);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // N2: safeFetch statt assertPublicHost + fetch — DNS-Lookup wird gepinnt,
    // kein Re-Resolve-Fenster mehr zwischen Check und Verbindung (TOCTOU).
    let res: Response;
    try {
      res = await safeFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-taxtronik-signature': signature,
          'x-taxtronik-timestamp': timestamp,
          'x-taxtronik-event': row.event,
          // Audit 5: Nonce als Replay-Schutz-Material für n8n-Empfänger.
          'x-taxtronik-nonce': nonce,
        },
        body,
        signal: ctrl.signal,
        // M-6: kein Auto-Redirect — verhindert, dass ein kompromittierter DNS-
        // Eintrag oder Reverse-Proxy via 302 auf interne URL umlenkt.
        redirect: 'error',
      });
    } catch (err) {
      // N2: SsrfGuardError-instanceof statt String-Match — Fehlerklasse aus
      // @taxtronik/http-utils ist typisiert (reason-Discriminator). Bei
      // Re-Check-Failure als FAILED markieren (kein Retry hilft).
      if (err instanceof SsrfGuardError) {
        log.error(
          { outboxId, url, reason: err.reason, err: err.message },
          'n8n-deliver: SSRF-Guard, marking FAILED',
        );
        await prismaOwner.n8nOutbox.update({
          where: { id: outboxId },
          data: { status: 'FAILED', lastError: `SSRF-Guard (${err.reason}): ${err.message}` },
        });
        return;
      }
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    await prismaOwner.n8nOutbox.update({
      where: { id: outboxId },
      data: { status: 'DELIVERED', deliveredAt: new Date(), lastError: null },
    });
    log.debug({ outboxId, event: row.event }, 'n8n-deliver: ok');
  } finally {
    clearTimeout(to);
  }
}

// -----------------------------------------------------------------------------
// Worker
// -----------------------------------------------------------------------------

export const n8nDeliverWorker = new Worker<N8nDeliverJob>(
  'n8n-deliver',
  async (job) => {
    try {
      await deliver(job.data.outboxId);
    } catch (err) {
      // Bei letztem Versuch: status=FAILED markieren. BullMQ ruft den Worker
      // nochmals auf, wenn attempts < opts.attempts — sonst landet der Job
      // im 'failed'-Event-Hook.
      const msg = (err as Error).message;
      await prismaOwner.n8nOutbox.update({
        where: { id: job.data.outboxId },
        data: { lastError: msg.slice(0, 1000) },
      });
      throw err; // BullMQ entscheidet über Retry
    }
  },
  { connection, concurrency: 4 },
);

n8nDeliverWorker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    // Letzter Versuch verbraucht — als FAILED stempeln.
    await prismaOwner.n8nOutbox.update({
      where: { id: job.data.outboxId },
      data: { status: 'FAILED', lastError: err.message.slice(0, 1000) },
    });
    log.error(
      { outboxId: job.data.outboxId, attempts: job.attemptsMade, err: err.message },
      'n8n-deliver: FAILED after all retries',
    );
  } else {
    log.warn(
      { outboxId: job.data.outboxId, attempt: job.attemptsMade, err: err.message },
      'n8n-deliver: retry pending',
    );
  }
});

// -----------------------------------------------------------------------------
// Reconciliation (täglich): findet stuck PENDING-Reihen (z. B. App-Crash
// zwischen outbox-write und BullMQ-enqueue) und reicht sie neu ein.
// -----------------------------------------------------------------------------

export const n8nOutboxReconcileWorker = new Worker(
  'n8n-outbox-reconcile',
  async () => {
    const cutoff = new Date(Date.now() - 5 * 60_000); // älter als 5 min
    const stuck = await prismaOwner.n8nOutbox.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    if (stuck.length === 0) return;

    const queue = new Queue<N8nDeliverJob>('n8n-deliver', { connection });
    for (const row of stuck) {
      await queue.add(
        'deliver',
        { outboxId: row.id },
        {
          attempts: 6,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: false,
        },
      );
    }
    await queue.close();
    log.info({ requeued: stuck.length }, 'n8n-outbox: reconciliation');
  },
  { connection },
);
