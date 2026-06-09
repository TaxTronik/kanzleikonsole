// =============================================================================
// audit-verify-check-Worker
//
// Verifiziert die Hash-Chain pro Tenant. Bei Bruch → SYSTEM_AUDIT_BREAK
// Notification an alle ADMIN/PARTNER. Idempotent (notify dedupliziert).
// =============================================================================

import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { prismaOwner } from '../prisma-owner';
import {
  EvidenceService,
  LocalTimestampAdapter,
  Rfc3161HttpAdapter,
} from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { withWorkerTenantContext } from '../tenant-context';


// C2: HTTP-Adapter statt Stub — der periodische Verify-Job nutzt
// timestampPort.verify(), das im Stub unbedingt wirft. Bei ENV-only-TSA
// reicht der HTTP-Adapter; Per-Tenant-TSA-Konfiguration (analog
// evidence-seal.ts) ist hier nicht nötig, weil verify() nur den Stamp
// validiert, nicht erneut signiert.
const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? new Rfc3161HttpAdapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();
const evidenceService = new EvidenceService(timestampPort);

// RF-5: Produktivmodus → externe TSA verpflichtend (Self-Timestamp = harter
// Fail). Symmetrisch zur CLI (packages/evidence/src/cli/verify.ts) — vorher
// lief der tägliche Check immer ohne Policy-Prüfung und ein Self-Timestamp
// in Produktion wäre nie aufgefallen.
const requireExternalTsa =
  env.NODE_ENV === 'production' || process.env['EVIDENCE_REQUIRE_TSA'] === 'true';

// M7: Tenant-Pagination. Bei vielen Tenants würde `findMany({})` ohne
// Limit alle Records in Memory laden, und die anschließende sequenzielle
// `evidenceService.verifyChain(tx, tenantId)`-Loop könnte Stunden laufen.
// Wir chunken in 50er-Blöcken; pro Chunk wird sequenziell verifiziert.
const TENANT_CHUNK_SIZE = 50;

async function loadTenantIdsChunked(): Promise<AsyncGenerator<string[]>> {
  async function* gen(): AsyncGenerator<string[]> {
    let cursor: string | undefined;
    while (true) {
      const rows = await prismaOwner.tenant.findMany({
        select: { id: true },
        take: TENANT_CHUNK_SIZE,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (rows.length === 0) return;
      yield rows.map((t) => t.id);
      if (rows.length < TENANT_CHUNK_SIZE) return;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  return gen();
}

export const auditVerifyWorker = new Worker<ChecksJob>(
  'audit-verify-check',
  async (job) => {
    const results: Array<{ tenantId: string; ok: boolean; broken?: string }> = [];
    const tenantBatches: AsyncGenerator<string[]> = job.data.tenantId
      ? (async function* () { yield [job.data.tenantId!]; })()
      : await loadTenantIdsChunked();

    for await (const tenantIds of tenantBatches) for (const tenantId of tenantIds) {
      try {
        const r = await prismaOwner.$transaction(async (tx) =>
          evidenceService.verifyChain(tx, tenantId, { requireExternalTsa }),
        );

        if (!r.ok) {
          // P-8: Notifications werden jetzt in einer Tenant-Context-Transaktion
          // geschrieben — auch wenn prismaOwner BYPASSRLS hat. Setzt die
          // app.current_*-Session-Variablen, sodass Audit-Trigger und etwaige
          // zukünftige RLS-Policies konsistent greifen. Symmetrisch zum
          // Web-App-Pattern (notify(tx, ...) innerhalb withTenantContext).
          await withWorkerTenantContext(tenantId, async (tx) => {
            const recipients = await tx.staffUser.findMany({
              where: {
                tenantId,
                active: true,
                roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
              },
              select: { id: true },
            });
            for (const rec of recipients) {
              const existing = await tx.notification.findFirst({
                where: {
                  tenantId,
                  staffId: rec.id,
                  kind: 'SYSTEM_AUDIT_BREAK',
                  resourceType: 'audit_log',
                  readAt: null,
                },
              });
              const data = {
                tenantId,
                staffId: rec.id,
                kind: 'SYSTEM_AUDIT_BREAK' as const,
                title: `⚠ Audit-Hash-Chain gebrochen!`,
                body: r.firstBreak
                  ? `Erster Bruch bei Audit-ID ${r.firstBreak.auditId} (${new Date(r.firstBreak.occurredAt).toISOString()})`
                  : `Verifikation fehlgeschlagen.`,
                href: `/staff/admin/audit`,
                resourceType: 'audit_log',
                resourceId: r.firstBreak ? String(r.firstBreak.auditId) : null,
              };
              if (existing) {
                await tx.notification.update({
                  where: { id: existing.id },
                  data: { ...data, createdAt: new Date() },
                });
              } else {
                await tx.notification.create({ data });
              }
            }
          });
          results.push({ tenantId, ok: false, broken: r.firstBreak ? String(r.firstBreak.auditId) : 'unknown' });
        } else {
          results.push({ tenantId, ok: true });
        }
      } catch (err) {
        log.error({ tenantId, err: (err as Error).message }, 'audit-verify: tenant failed');
        results.push({ tenantId, ok: false, broken: 'verify-error' });
      }
    }

    log.info({ results }, 'audit-verify: done');
    return { results };
  },
  { connection, concurrency: 1 },
);

auditVerifyWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'audit-verify: failed');
});
