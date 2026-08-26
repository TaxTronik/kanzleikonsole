// =============================================================================
// Magic-Link-Cleanup-Worker (H6)
//
// Magic-Links akkumulieren in der DB (consumed + abgelaufen). Pro Mandanten-
// Login mindestens 1 Row, plus Cancelled-Auths usw. Bei vielen Tenants über
// Jahre hinweg → Tabellenwachstum, langsame Indexe.
//
// Strategie: täglich alle Rows löschen, deren expires_at älter als 7 Tage ist.
// Das deckt sowohl bereits konsumierte als auch nie konsumierte Rows ab —
// nach 7 Tagen ist der Token in beiden Fällen wertlos.
//
// Idempotent: bei doppelter Ausführung pro Tag ist die zweite ein no-op.
// =============================================================================

import { Worker } from 'bullmq';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';

const RETENTION_DAYS = 7;

export const magicLinkCleanupWorker = new Worker<ChecksJob>(
  JOB_QUEUES.magicLinkCleanup.name,
  async () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await prismaOwner.magicLink.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    log.info({ deleted: result.count, cutoff: cutoff.toISOString() }, 'magic-link-cleanup');
  },
  { connection },
);
