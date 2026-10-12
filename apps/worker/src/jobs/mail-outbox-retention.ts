// =============================================================================
// mail-outbox-retention — Löschfrist der Mail-Outbox-Metadaten (Welle 15, A8)
//
// Versandaufträge der Mandanten-Mails (mail_outbox) wurden nie gelöscht. Nach
// dem Endstatus enthalten sie nur noch Metadaten: Anlass, Status, Zeitpunkte,
// Zähler, Vorgangs- und Mandantenbezug und gegebenenfalls die Begründung eines
// Verwerfens; Empfänger und Inhalt entfernt bereits der Zustell-Worker
// (mail-outbox.ts). Entscheidung A8: „1 Jahr wie die Versandhistorie“. Die
// Frist entspricht deshalb genau der pseudonymen Steuertermin-Versandhistorie
// in dsgvo-retention.ts: ein Kalenderjahr (setFullYear, schaltjahrkorrekt),
// gelöscht wird nur, was strikt älter als der Stichtag ist.
//
// Gelöscht werden Aufträge im Endstatus (PROVIDER_ACCEPTED, PARTIAL_FAILURE,
// NO_RECIPIENT, FAILED, UNKNOWN, SKIPPED), deren letzter Statuswechsel vor dem
// Stichtag liegt; wartende und laufende Aufträge (QUEUED, RETRY_PENDING,
// SENDING) nie. Bei FAILED und UNKNOWN zählt die Eskalation, weil das Entfernen
// des Neuversandinhalts nach 30 Tagen nur updated_at ändert. Danach zeigt der
// Vorgang für diese Mail keinen Zustellstatus mehr.
//
// S-01: Je Tenant über die App-Rolle im SYSTEM-Kontext (withSystemContext,
// RLS). Die App-Rolle hat kein DELETE auf mail_outbox; die Löschung kapselt
// app.mail_outbox_purge_terminal (Migration 20261012110000), die Tenant,
// Akteurstyp, Endstatus, Mindestalter und Stapelgröße selbst erzwingt. Nur die
// Tenant-Liste (IDs) liest der Owner-Client. Idempotent: Ein zweiter Lauf
// findet nichts mehr. Ein Lauf endet am Zeitbudget der Wartungsjobs (P-17) und
// meldet den verbleibenden Rückstand; Zähler und Stichtag stehen im Log.
// =============================================================================

import type { Worker } from 'bullmq';
import type { MailOutboxStatus, Prisma } from '@prisma/client';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { withSystemContext, type TxClient } from '@taxtronik/db';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';
import { isWorkerClosing, startRunBudget, type RunBudget } from '../run-budget';

export const MAIL_OUTBOX_RETENTION_YEARS = 1;
/** Aufträge je Aufruf von app.mail_outbox_purge_terminal (die Funktion erlaubt bis 1.000). */
export const MAIL_OUTBOX_RETENTION_BATCH_SIZE = 500;

/** Endstatus, deren letzter Statuswechsel updated_at ist. */
const SETTLED_STATUSES = [
  'PROVIDER_ACCEPTED',
  'PARTIAL_FAILURE',
  'NO_RECIPIENT',
  'SKIPPED',
] as const satisfies readonly MailOutboxStatus[];
/** Endstatus mit Eskalation; der Neuversandinhalt wird später ohne Statuswechsel entfernt. */
const ESCALATED_STATUSES = ['FAILED', 'UNKNOWN'] as const satisfies readonly MailOutboxStatus[];

/** Alle Endstatus; QUEUED, RETRY_PENDING und SENDING werden nie gelöscht. */
export const MAIL_OUTBOX_TERMINAL_STATUSES: readonly MailOutboxStatus[] = [
  ...SETTLED_STATUSES,
  ...ESCALATED_STATUSES,
];

/**
 * Stichtag: ein Kalenderjahr vor `now`, wie yearsAgo in dsgvo-retention.ts.
 * Gelöscht wird nur, was strikt davor liegt.
 */
export function mailOutboxRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setFullYear(cutoff.getFullYear() - MAIL_OUTBOX_RETENTION_YEARS);
  return cutoff;
}

/**
 * Fällige Aufträge eines Tenants für den Rückstand — dieselbe Bedingung wie
 * app.mail_outbox_purge_terminal (der DB-Test prüft die Übereinstimmung).
 */
export function dueMailOutboxWhere(tenantId: string, cutoff: Date): Prisma.MailOutboxWhereInput {
  return {
    tenantId,
    OR: [
      { status: { in: [...SETTLED_STATUSES] }, updatedAt: { lt: cutoff } },
      {
        status: { in: [...ESCALATED_STATUSES] },
        OR: [{ escalatedAt: { lt: cutoff } }, { escalatedAt: null, updatedAt: { lt: cutoff } }],
      },
    ],
  };
}

async function purgeBatchTx(tx: TxClient, cutoff: Date): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ deleted: number }>>`
    SELECT app.mail_outbox_purge_terminal(
      ${cutoff}::timestamptz,
      ${MAIL_OUTBOX_RETENTION_BATCH_SIZE}::integer
    ) AS "deleted"`;
  return Number(row?.deleted ?? 0);
}

export interface MailOutboxRetentionResult {
  /** Gelöschte Aufträge (alle Tenants). */
  deleted: number;
  /** Tenants mit mindestens einem gelöschten Auftrag. */
  tenantsWithDeletions: number;
  /** Stichtag (ISO-8601); gelöscht wurde, was strikt davor lag. */
  cutoff: string;
  /** Nach dem Lauf weiterhin fällige Aufträge (alle Tenants). */
  backlog: number;
  /** Der Lauf endete am Zeitbudget oder wegen Herunterfahrens. */
  budgetExhausted: boolean;
}

/** Löscht die fälligen Aufträge eines Tenants stapelweise; false = Budget erschöpft. */
async function purgeTenant(
  tenantId: string,
  cutoff: Date,
  budget: RunBudget,
  deleted: { count: number },
): Promise<boolean> {
  for (;;) {
    if (budget.exhausted()) return false;
    const count = await withSystemContext(tenantId, (tx) => purgeBatchTx(tx, cutoff));
    deleted.count += count;
    // Ein nicht voller Stapel enthielt alle fälligen, nicht gesperrten Aufträge.
    if (count < MAIL_OUTBOX_RETENTION_BATCH_SIZE) return true;
  }
}

/**
 * Ein Lauf über alle Tenants (geplanter Job) oder nur über `tenantIds`
 * (gezielter Lauf, Tests).
 */
export async function runMailOutboxRetention(
  input: { now?: Date; budget?: RunBudget; tenantIds?: readonly string[] } = {},
): Promise<MailOutboxRetentionResult> {
  const cutoff = mailOutboxRetentionCutoff(input.now ?? new Date());
  const budget = input.budget ?? startRunBudget();
  // S-01: Die mandantenübergreifende Tenant-Liste (nur IDs) liest der Owner-Client.
  const tenants = await prismaOwner.tenant.findMany({
    where: input.tenantIds ? { id: { in: [...input.tenantIds] } } : {},
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  let deleted = 0;
  let tenantsWithDeletions = 0;
  let budgetExhausted = false;
  for (const { id } of tenants) {
    const tenantDeleted = { count: 0 };
    const finished = await purgeTenant(id, cutoff, budget, tenantDeleted);
    if (tenantDeleted.count > 0) {
      tenantsWithDeletions += 1;
      deleted += tenantDeleted.count;
      log.info(
        {
          component: 'mail-outbox-retention',
          tenantId: id,
          deleted: tenantDeleted.count,
          cutoff: cutoff.toISOString(),
        },
        'mail-outbox-retention: terminal outbox rows deleted',
      );
    }
    if (!finished) {
      budgetExhausted = true;
      break;
    }
  }

  let backlog = 0;
  for (const { id } of tenants) {
    backlog += await withSystemContext(id, (tx) =>
      tx.mailOutbox.count({ where: dueMailOutboxWhere(id, cutoff) }),
    );
  }

  const result: MailOutboxRetentionResult = {
    deleted,
    tenantsWithDeletions,
    cutoff: cutoff.toISOString(),
    backlog,
    budgetExhausted,
  };
  const summary = { component: 'mail-outbox-retention', ...result };
  if (budgetExhausted) {
    log.warn(summary, 'mail-outbox-retention: Zeitbudget erreicht, Rückstand im nächsten Lauf');
  } else {
    log.info(summary, 'mail-outbox-retention finished');
  }
  return result;
}

// Typ explizit: der Processor liest `closing` des eigenen Workers (P-17).
export const mailOutboxRetentionWorker: Worker<Record<string, never>> = createWorker<
  Record<string, never>
>(
  JOB_QUEUES.mailOutboxRetention.name,
  async () =>
    runMailOutboxRetention({
      budget: startRunBudget({ stop: () => isWorkerClosing(mailOutboxRetentionWorker) }),
    }),
  { connection, concurrency: 1 },
);
