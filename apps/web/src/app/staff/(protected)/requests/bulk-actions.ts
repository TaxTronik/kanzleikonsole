'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { Prisma } from '@taxtronik/db/prisma-client';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { emitN8nEvent } from '@/server/n8n/emit';
import { staffActionGuard } from '@/server/actions/staff-action';

const BulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

/** Eine Anforderung, die der Bulk-Lauf nicht geschlossen hat. */
export interface BulkFailure {
  id: string;
  /** Titel, soweit noch lesbar; sonst null (die UI zeigt dann die ID). */
  title: string | null;
  /** Fachlich verständlicher Grund — Details stehen im Server-Log. */
  reason: string;
}

export interface BulkResult {
  ok: boolean;
  affected: number;
  error?: string;
  /** F-05: welche Anforderungen nicht geschlossen wurden und warum. */
  failed?: BulkFailure[];
}

// Pro Tenant serialisiert evidenceService.record die Audit-Inserts über einen
// pg_advisory_xact_lock, der bis zum Tx-Ende gehalten wird. Liefe der ganze Bulk
// (bis 200 Items) in EINER Tx, blockierte der Lock alle anderen Audit-Writes des
// Tenants für die volle Tx-Dauer (und näherte sich dem 15-s-Tx-Timeout). Wir
// splitten daher in kleine Tx-Chunks: kurzer Lock, andere Writes kommen
// dazwischen durch. Trade-off: nicht mehr atomar — bricht ein Chunk ab, bleiben
// frühere committet (für ein idempotentes Bulk-Close akzeptabel).
const BULK_CHUNK = 25;
// F-05: Scheitert ein Chunk, werden seine Anforderungen einzeln geschlossen, damit
// eine einzelne, an einer Datenbankregel scheiternde Anforderung die übrigen nicht
// blockiert und benannt werden kann. Mehrere Fehlschläge in Folge deuten auf eine
// systemische Ursache (DB weg, Lock-Stau): dann wird der Rest nicht mehr versucht.
const MAX_CONSECUTIVE_ITEM_FAILURES = 3;
const FAILURES_IN_MESSAGE = 3;
const NOT_ATTEMPTED_REASON = 'nicht verarbeitet — Abbruch nach wiederholten Fehlern';

type KnownRequestError = InstanceType<typeof Prisma.PrismaClientKnownRequestError>;

function sqlStateOf(error: KnownRequestError): string | null {
  const cause = (error.meta?.['driverAdapterError'] as { cause?: { originalCode?: unknown } })
    ?.cause;
  return typeof cause?.originalCode === 'string' ? cause.originalCode : null;
}

/** Ordnet einen Fehler einem verständlichen Grund zu, ohne Interna anzuzeigen. */
function bulkCloseFailureReason(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const sqlState = sqlStateOf(error);
    if (error.code === 'P2028' || sqlState === '57014' || sqlState === '55P03') {
      return 'Zeitüberschreitung — bitte erneut versuchen';
    }
    if (error.code === 'P2034' || sqlState === '40001' || sqlState === '40P01') {
      return 'Konflikt mit einer parallelen Änderung — bitte erneut versuchen';
    }
    if (sqlState === 'P0001' || sqlState?.startsWith('23')) {
      return 'Datenbankregel verhindert das Schließen (z. B. Verknüpfung mit Steuertermin oder Workflow) — bitte einzeln prüfen';
    }
    return 'Datenbankfehler';
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return 'Datenbank nicht erreichbar';
  }
  return 'technischer Fehler';
}

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      errName: error.name,
      code: error.code,
      sqlState: sqlStateOf(error),
      err: error.message,
    };
  }
  return error instanceof Error
    ? { errName: error.name, err: error.message }
    : { err: String(error) };
}

function failureSummary(failures: BulkFailure[], closed: number): string {
  const listed = failures
    .slice(0, FAILURES_IN_MESSAGE)
    .map((failure) => `„${failure.title ?? failure.id}“ (${failure.reason})`)
    .join('; ');
  const more =
    failures.length > FAILURES_IN_MESSAGE
      ? ` und ${failures.length - FAILURES_IN_MESSAGE} weitere`
      : '';
  return `Teilweise abgeschlossen: ${closed} geschlossen, ${failures.length} nicht geschlossen — ${listed}${more}.`;
}

export async function bulkCloseRequestsAction(input: { ids: string[] }): Promise<BulkResult> {
  // Massenoperationen über mehrere Mandanten hinweg — nur ADMIN/PARTNER.
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return { ok: false, affected: 0, error: g.error };
  const { tenantId, staffId, ctx } = g;

  const parsed = BulkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, affected: 0, error: 'Validierungsfehler.' };

  const closeRequests = (ids: string[]) =>
    withTenantContext(ctx, async (tx) => {
      const before = await tx.request.findMany({
        where: { id: { in: ids }, status: { notIn: ['CLOSED', 'CANCELLED'] } },
        select: { id: true, status: true },
      });
      if (before.length === 0) return [] as string[];

      await tx.request.updateMany({
        where: { id: { in: before.map((b) => b.id) } },
        data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: staffId },
      });
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: before.map((request) => ({
          resourceType: 'request',
          resourceId: request.id,
        })),
      });

      // Pro Eintrag ein Audit-Log
      for (const b of before) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request.close',
          resourceType: 'request',
          resourceId: b.id,
          before: { status: b.status },
          after: { status: 'CLOSED', bulk: true },
        });
      }

      return before.map((b) => b.id);
    });

  const closedIds: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  let aborted = false;
  let consecutiveFailures = 0;

  for (let i = 0; i < parsed.data.ids.length; i += BULK_CHUNK) {
    const chunkIds = parsed.data.ids.slice(i, i + BULK_CHUNK);
    if (aborted) {
      failures.push(...chunkIds.map((id) => ({ id, reason: NOT_ATTEMPTED_REASON })));
      continue;
    }
    try {
      closedIds.push(...(await closeRequests(chunkIds)));
      consecutiveFailures = 0;
      continue;
    } catch (chunkError) {
      // Bereits committete Chunks bleiben gültig; dieser wurde zurückgerollt.
      log.warn(
        {
          component: 'bulk-close',
          tenantId,
          staffId,
          chunkSize: chunkIds.length,
          ...errorLogFields(chunkError),
        },
        'bulk-close: Chunk fehlgeschlagen — Anforderungen werden einzeln geschlossen',
      );
    }
    for (const id of chunkIds) {
      if (aborted) {
        failures.push({ id, reason: NOT_ATTEMPTED_REASON });
        continue;
      }
      try {
        closedIds.push(...(await closeRequests([id])));
        consecutiveFailures = 0;
      } catch (itemError) {
        log.error(
          {
            component: 'bulk-close',
            tenantId,
            staffId,
            requestId: id,
            ...errorLogFields(itemError),
          },
          'bulk-close: Anforderung nicht geschlossen',
        );
        failures.push({ id, reason: bulkCloseFailureReason(itemError) });
        consecutiveFailures += 1;
        aborted = consecutiveFailures >= MAX_CONSECUTIVE_ITEM_FAILURES;
      }
    }
  }

  // n8n-Events fire-and-forget — NUR über die tatsächlich geschlossenen Requests.
  // Über die rohe Eingabe (parsed.data.ids) zu feuern würde request.closed auch
  // für bereits geschlossene, nicht existierende oder RLS-gefilterte IDs auslösen
  // → spurious, client-wirksame Downstream-Notifications.
  // Der Bulk-Endpunkt verarbeitet bis zu 200 Anforderungen. Kleine Batches
  // begrenzen gleichzeitige Outbox-Transaktionen und damit den DB-Pool-Druck.
  for (let offset = 0; offset < closedIds.length; offset += 10) {
    await Promise.all(
      closedIds
        .slice(offset, offset + 10)
        .map((id) => emitN8nEvent('request.closed', { tenantId, requestId: id }, { tenantId })),
    );
  }
  revalidatePath('/staff/requests');
  if (failures.length === 0) return { ok: true, affected: closedIds.length };

  // Titel nur zur Anzeige; ist die DB gerade weg, bleibt es bei den IDs.
  const titles = new Map<string, string>();
  try {
    const rows = await withTenantContext(ctx, (tx) =>
      tx.request.findMany({
        where: { id: { in: failures.map((failure) => failure.id) } },
        select: { id: true, title: true },
      }),
    );
    for (const row of rows) titles.set(row.id, row.title);
  } catch (titleError) {
    log.warn(
      { component: 'bulk-close', tenantId, staffId, ...errorLogFields(titleError) },
      'bulk-close: Titel der nicht geschlossenen Anforderungen nicht lesbar',
    );
  }
  const failed = failures.map((failure) => ({
    id: failure.id,
    title: titles.get(failure.id) ?? null,
    reason: failure.reason,
  }));
  return {
    ok: false,
    affected: closedIds.length,
    error: failureSummary(failed, closedIds.length),
    failed,
  };
}
