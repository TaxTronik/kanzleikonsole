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
    const url = resolveTsaUrl(v.providerId ?? null, v.customUrl ?? null);
    if (url) {
      // F1: TOCTOU-Schutz. Die URL wurde beim Save geprüft (NEW1), aber
      // DNS-Rebinding oder Legacy-Configs könnten zwischenzeitlich auf
      // private IPs zeigen. Vor jedem täglichen Use erneut prüfen.
      try {
        await assertPublicHost(url);
      } catch (err) {
        log.warn(
          { tenantId, url, err: (err as Error).message },
          'evidence-seal: TSA-URL nicht öffentlich auflösbar — Fallback auf LocalTimestamp',
        );
        return new LocalTimestampAdapter();
      }
      return new Rfc3161HttpAdapter(url);
    }
  }
  if (env.TIMESTAMP_AUTHORITY_URL) {
    try {
      await assertPublicHost(env.TIMESTAMP_AUTHORITY_URL);
    } catch (err) {
      log.warn(
        { url: env.TIMESTAMP_AUTHORITY_URL, err: (err as Error).message },
        'evidence-seal: ENV-TSA-URL nicht öffentlich auflösbar — Fallback auf LocalTimestamp',
      );
      return new LocalTimestampAdapter();
    }
    return new Rfc3161HttpAdapter(env.TIMESTAMP_AUTHORITY_URL);
  }
  return new LocalTimestampAdapter();
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

    const sealDate = job.data.sealDate
      ? new Date(job.data.sealDate)
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // gestern

    const results: Array<{ tenantId: string; sealed: boolean; reason?: string }> = [];

    for (const tenantId of tenantIds) {
      try {
        const port = await timestampPortFor(tenantId);
        const service = new EvidenceService(port);
        const r = await prismaOwner.$transaction(async (tx) => {
          // RLS bypass — Owner-Verbindung
          return service.sealDay(tx, tenantId, sealDate);
        });
        results.push({ tenantId, ...r });
        log.info({ tenantId, sealDate: sealDate.toISOString().slice(0, 10), ...r }, 'evidence-seal: tenant');
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
