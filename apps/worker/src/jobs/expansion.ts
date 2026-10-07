import { createWorker } from '../worker-factory';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { withSystemContext } from '@taxtronik/db';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { pollMailbox } from '@taxtronik/mail/imap';
import { connection, type ChecksJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { runSanctionsRefresh } from './sanctions-refresh';

export const mailboxPollWorker = createWorker<ChecksJob>(
  JOB_QUEUES.mailboxPoll.name,
  async (job) => {
    // S-01: Die mandantenübergreifende Tenant-Liste (nur IDs) liest der Owner-Client.
    const tenants = job.data.tenantId
      ? [{ id: job.data.tenantId }]
      : await prismaOwner.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      const accounts = await withSystemContext(tenant.id, async (tx) =>
        (await readBooleanTenantModules(tx, tenant.id)).smartMailbox
          ? tx.inboundMailbox.findMany({
              where: { tenantId: tenant.id, enabled: true },
              select: { id: true },
            })
          : [],
      );
      for (const account of accounts) await pollMailbox(tenant.id, account.id);
    }
  },
  { connection, concurrency: 1 },
);
export const sanctionsRefreshWorker = createWorker<ChecksJob>(
  JOB_QUEUES.sanctionsRefresh.name,
  async (job) => {
    await runSanctionsRefresh(job.data.tenantId);
  },
  { connection, concurrency: 1 },
);
