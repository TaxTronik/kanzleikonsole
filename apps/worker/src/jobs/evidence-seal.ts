// =============================================================================
// evidence-seal-Worker
//
// Versiegelt den Tages-Spitzen-Hash mit RFC-3161 (oder Self-Timestamp im MVP).
// Wird täglich vom Repeat-Scheduler getriggert (siehe scheduler.ts).
// =============================================================================

import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { prismaOwner } from '../prisma-owner';
import {
  EvidenceService,
  LocalTimestampAdapter,
  Rfc3161HttpAdapter,
  resolveTsaUrl,
  type TimestampPort,
} from '@taxtronik/evidence';
import { connection, type EvidenceSealJob } from '../queues';
import { log } from '../logger';
import { assertPublicHost } from '../http/ssrf-guard';

const DEFAULT_TSA_PROVIDER_ID = 'globalsign';

/**
 * Bevorzugt die tenant-spezifische TSA-Konfiguration (UI-gepflegt), Fallback
 * auf die ENV-Variable, dann lokaler Self-Timestamp.
 */
async function timestampPortFor(tenantId: string): Promise<TimestampPort> {
  const row = await prismaOwner.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: 'evidence.tsa' } },
    select: { value: true },
  });
  if (row) {
    const v = row.value as { providerId?: string; customUrl?: string };
    const url = resolveTsaUrl(v.providerId || DEFAULT_TSA_PROVIDER_ID, v.customUrl ?? null);
    if (url) {
      // F1: TOCTOU-Schutz. Die URL wurde beim Save geprüft (NEW1), aber
      // DNS-Rebinding oder Legacy-Configs könnten zwischenzeitlich auf
      // private IPs zeigen. Vor jedem täglichen Use erneut prüfen.
      try {
        await assertPublicHost(url);
      } catch (err) {
        if (env.NODE_ENV === 'production') throw err;
        log.warn(
          { tenantId, url, err: (err as Error).message },
          'evidence-seal: TSA-URL nicht öffentlich auflösbar — Fallback auf LocalTimestamp',
        );
        return new LocalTimestampAdapter();
      }
      return new Rfc3161HttpAdapter(url);
    }
  }
  const fallbackUrl = env.TIMESTAMP_AUTHORITY_URL ?? resolveTsaUrl(DEFAULT_TSA_PROVIDER_ID, null);
  if (fallbackUrl) {
    try {
      await assertPublicHost(fallbackUrl);
    } catch (err) {
      if (env.NODE_ENV === 'production') throw err;
      log.warn(
        { url: fallbackUrl, err: (err as Error).message },
        'evidence-seal: ENV-TSA-URL nicht öffentlich auflösbar — Fallback auf LocalTimestamp',
      );
      return new LocalTimestampAdapter();
    }
    return new Rfc3161HttpAdapter(fallbackUrl);
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Production erfordert eine externe RFC-3161-TSA.');
  }
  return new LocalTimestampAdapter();
}

const DAY_MS = 24 * 60 * 60 * 1000;
// RF-2: harte Obergrenze pro Lauf — schützt vor Endlosschleifen bei kaputten
// Daten (z. B. occurred_at weit in der Vergangenheit). Der Rest des Backlogs
// wird von den Folgeläufen abgearbeitet (sealDay ist idempotent).
const MAX_BACKFILL_DAYS = 366;

/** UTC-Mitternacht des Tages, in dem `d` liegt. */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * RF-2: Alle noch unversiegelten Tage eines Tenants bis einschließlich gestern
 * (UTC). Vorher versiegelte der Job stur „jetzt − 24 h" — fiel ein Lauf aus
 * (Worker down, TSA down), blieb der Tag dauerhaft unversiegelt. Startpunkt:
 * Tag nach dem letzten Seal, sonst der älteste audit_log-Tag.
 */
async function pendingSealDays(tenantId: string): Promise<Date[]> {
  const yesterday = utcDayStart(new Date(Date.now() - DAY_MS));

  // seal_date als Text lesen — date-Spalten würden je nach Treiber-TZ sonst
  // auf den Vortag kippen (gleiche Vorsicht wie RF-6 in sealDay).
  const lastSeal = await prismaOwner.$queryRaw<Array<{ max: string | null }>>`
    SELECT max(seal_date)::text AS max FROM audit_seal WHERE tenant_id = ${tenantId}::uuid
  `;
  // Startpunkt: ältestes Audit-Event NACH dem letzten Seal-Tag. Tage ganz ohne
  // Events brauchen keinen Seal — so iteriert ein ruhiger Tenant nicht jeden
  // Tag erneut über einen langen leeren Zeitraum.
  const afterLastSeal = lastSeal[0]?.max
    ? new Date(new Date(`${lastSeal[0].max}T00:00:00.000Z`).getTime() + DAY_MS)
    : undefined;
  const oldest = await prismaOwner.auditLog.aggregate({
    _min: { occurredAt: true },
    where: { tenantId, ...(afterLastSeal ? { occurredAt: { gte: afterLastSeal } } : {}) },
  });
  if (!oldest._min.occurredAt) return []; // nichts Unversiegeltes
  const start = utcDayStart(oldest._min.occurredAt);

  const days: Date[] = [];
  for (let t = start.getTime(); t <= yesterday.getTime(); t += DAY_MS) {
    if (days.length >= MAX_BACKFILL_DAYS) {
      log.warn(
        { tenantId, start: start.toISOString().slice(0, 10), capped: MAX_BACKFILL_DAYS },
        'evidence-seal: Backfill-Obergrenze erreicht — Rest folgt bei den nächsten Läufen',
      );
      break;
    }
    days.push(new Date(t));
  }
  return days;
}

export const evidenceSealWorker = new Worker<EvidenceSealJob>(
  'evidence-seal',
  async (job) => {
    let tenantIds: string[];
    if (job.data.tenantId) {
      tenantIds = [job.data.tenantId];
    } else {
      const tenants = await prismaOwner.tenant.findMany({ select: { id: true } });
      tenantIds = tenants.map((t) => t.id);
    }

    const results: Array<{ tenantId: string; sealed: boolean; reason?: string }> = [];

    for (const tenantId of tenantIds) {
      try {
        // RF-2: Manual-Trigger mit explizitem Datum versiegelt genau diesen
        // Tag; der Scheduler-Lauf füllt alle verpassten Tage bis gestern auf.
        const days = job.data.sealDate
          ? [new Date(job.data.sealDate)]
          : await pendingSealDays(tenantId);
        if (days.length === 0) continue;

        const port = await timestampPortFor(tenantId);
        const service = new EvidenceService(port);
        for (const sealDate of days) {
          // RF-4: bewusst KEINE Transaktion mehr um sealDay — der TSA-HTTP-Call
          // (bis 10 s) riss das interaktive 5-s-Prisma-TX-Timeout (P2028).
          // Idempotenz/Race-Sicherheit liegt jetzt in sealDay selbst.
          const r = await service.sealDay(prismaOwner, tenantId, sealDate);
          results.push({ tenantId, ...r });
          log.info({ tenantId, sealDate: sealDate.toISOString().slice(0, 10), ...r }, 'evidence-seal: tenant');
        }
      } catch (err) {
        log.error({ tenantId, err: (err as Error).message }, 'evidence-seal: tenant failed');
        results.push({ tenantId, sealed: false, reason: (err as Error).message });
      }
    }
    return { sealed: results };
  },
  { connection, concurrency: 1 },
);

evidenceSealWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'evidence-seal: failed');
});
