// =============================================================================
// Bulk-Kern der Dokumentenverwaltung (Review-Finding P-18).
//
// Früher rief der Explorer je Dokument eine Server Action auf. Next.js stellt
// Actions pro Client seriell zu, jede revalidierte die Liste, danach folgte
// noch ein Router-Refresh: 100 Dokumente bedeuteten 101 Seiten-Renders. Jetzt
// verarbeitet EINE Action die ganze Auswahl:
//
//   • eine Transaktion je Block von bis zu BULK_TX_ITEMS Einträgen (also eine
//     Transaktion für jede übliche Auswahl). Der Block sperrt zuerst alle seine
//     Zeilen in ID-Reihenfolge und erst danach nimmt das erste Audit-Event den
//     tenantweiten Audit-Lock — dieselbe Reihenfolge (Zeile vor Audit-Lock) wie
//     jede Einzel-Action, sonst könnten sich Block und Einzel-Action gegenseitig
//     blockieren (Deadlock);
//   • Zugriffsprüfung, Fachprüfungen und Audit-Event je Eintrag wie bei der
//     Einzel-Action (dieselben Funktionen); das Ergebnis der Zugriffsprüfung
//     gilt je Mandant für die Transaktion;
//   • eine fachliche Ablehnung (ActionError/ForbiddenError) betrifft nur ihren
//     Eintrag: bis dahin hat er nur gelesen, die Transaktion läuft weiter;
//   • scheitert die Transaktion an der Datenbank (Trigger, Konflikt), wird der
//     Block einzeln wiederholt — je Eintrag eine Transaktion wie früher —,
//     damit ein Eintrag die übrigen nicht blockiert und benannt werden kann;
//     nach drei Fehlschlägen in Folge bricht der Lauf ab (systemische Ursache);
//   • die Action revalidiert danach einmal; der Client ruft kein
//     Router-Refresh mehr (die Action-Antwort rendert die Seite bereits neu).
// =============================================================================

import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import { ActionError, type StaffCtx } from '@/server/actions/staff-action';
import type { StaffSession } from '@/server/auth/staff';
import { log } from '@/server/logger';

/** Höchstzahl an Einträgen je Bulk-Aufruf — so viele zeigt der Explorer höchstens (DOCS_CAP). */
export const DOCUMENT_BULK_MAX = 1000;
/**
 * Einträge je Transaktion. Begrenzt, wie lange der tenantweite Audit-Lock
 * (pg_advisory_xact_lock in evidenceService.record) gehalten wird.
 */
export const BULK_TX_ITEMS = 200;
const MAX_CONSECUTIVE_FAILURES = 3;

export const INVALID_DOCUMENT_SELECTION = 'Ungültige Dokumentauswahl.';
export const BULK_NOT_ATTEMPTED = 'Nicht verarbeitet — Abbruch nach wiederholten Fehlern.';

export interface DocumentBulkRejection {
  id: string;
  /** Dieselbe UI-taugliche Meldung wie bei der Einzel-Action. */
  error: string;
}

/** Ergebnis einer Bulk-Action der Dokumentenverwaltung. */
export interface DocumentBulkResult {
  /** true, wenn jeder Eintrag verarbeitet wurde. */
  ok: boolean;
  /** Verarbeitete Einträge (unverändert gebliebene eingeschlossen). */
  done: number;
  rejected: DocumentBulkRejection[];
  /** Noch offene Einträge (Zeitbudget der Umklassifizierung mit Re-Store). */
  pending?: string[];
  /** Fehler vor jeder Verarbeitung (Sitzung, Auswahl, Ziel). */
  error?: string;
}

export type AssertClientAccess = (clientId: string) => Promise<void>;

export interface BulkOutcome<T> {
  done: Array<{ id: string; value: T }>;
  rejected: DocumentBulkRejection[];
}

/** Zugriffsprüfung wie in den Einzel-Actions. */
export function clientAccessCheck(tx: TxClient, session: StaffSession): AssertClientAccess {
  return (clientId) => assertClientAccessTx(tx, session, clientId);
}

/** Zugriffsprüfung je Mandant einmal je Transaktion (Erfolg und Ablehnung). */
export function memoizedClientAccess(tx: TxClient, session: StaffSession): AssertClientAccess {
  const checks = new Map<string, Promise<void>>();
  return (clientId) => {
    let check = checks.get(clientId);
    if (!check) {
      check = assertClientAccessTx(tx, session, clientId);
      checks.set(clientId, check);
    }
    return check;
  };
}

/**
 * Fachliche Ablehnung eines Eintrags. Sie entsteht vor dessen erstem Write,
 * die Transaktion bleibt also nutzbar. Datenbankfehler gehören nicht dazu.
 */
export function isBulkItemRejection(error: unknown): boolean {
  return (
    error instanceof ActionError ||
    (error instanceof Error &&
      (error.name === 'ForbiddenError' || error.name === 'UnauthorizedError'))
  );
}

function errorLogFields(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { errName: error.name, code: (error as { code?: unknown }).code, err: error.message }
    : { err: String(error) };
}

/**
 * Führt `apply` für alle Einträge aus: je Block eine Transaktion, Rückfall auf
 * Einzel-Transaktionen nur, wenn die Blocktransaktion an der Datenbank scheitert.
 */
export async function runDocumentBulk<I extends { id: string }, T>(
  staff: StaffCtx,
  items: readonly I[],
  apply: (tx: TxClient, item: I, assertAccess: AssertClientAccess) => Promise<T>,
  opts: {
    component: string;
    errorMessage?: (error: unknown) => string;
    /** Sperrt die Zeilen des Blocks vor dem ersten Eintrag (siehe Kopfkommentar). */
    lockBlock?: (tx: TxClient, items: readonly I[]) => Promise<void>;
  },
): Promise<BulkOutcome<T>> {
  const errorMessage = opts.errorMessage ?? ((error: unknown) => toActionError(error).error);
  const ordered = [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const outcome: BulkOutcome<T> = { done: [], rejected: [] };
  let consecutiveFailures = 0;
  const notAttempted = (item: I) =>
    outcome.rejected.push({ id: item.id, error: BULK_NOT_ATTEMPTED });

  for (let offset = 0; offset < ordered.length; offset += BULK_TX_ITEMS) {
    const block = ordered.slice(offset, offset + BULK_TX_ITEMS);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      block.forEach(notAttempted);
      continue;
    }
    let blockError: unknown;
    try {
      const blockOutcome = await withTenantContext(staff.ctx, async (tx) => {
        await opts.lockBlock?.(tx, block);
        const assertAccess = memoizedClientAccess(tx, staff.session);
        const result: BulkOutcome<T> = { done: [], rejected: [] };
        for (const item of block) {
          try {
            result.done.push({ id: item.id, value: await apply(tx, item, assertAccess) });
          } catch (error) {
            if (!isBulkItemRejection(error)) throw error;
            result.rejected.push({ id: item.id, error: errorMessage(error) });
          }
        }
        return result;
      });
      outcome.done.push(...blockOutcome.done);
      outcome.rejected.push(...blockOutcome.rejected);
      consecutiveFailures = 0;
      continue;
    } catch (error) {
      blockError = error;
    }

    // Die Blocktransaktion ist zurückgerollt; kein Eintrag gilt als verarbeitet.
    if (block.length === 1) {
      outcome.rejected.push({ id: block[0]!.id, error: errorMessage(blockError) });
      consecutiveFailures += 1;
      continue;
    }
    log.warn(
      {
        component: opts.component,
        tenantId: staff.tenantId,
        staffId: staff.staffId,
        blockSize: block.length,
        ...errorLogFields(blockError),
      },
      'document-bulk: Blocktransaktion gescheitert — Einträge werden einzeln verarbeitet',
    );
    for (const item of block) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        notAttempted(item);
        continue;
      }
      try {
        const value = await withTenantContext(staff.ctx, (tx) =>
          apply(tx, item, clientAccessCheck(tx, staff.session)),
        );
        outcome.done.push({ id: item.id, value });
        consecutiveFailures = 0;
      } catch (error) {
        outcome.rejected.push({ id: item.id, error: errorMessage(error) });
        consecutiveFailures = isBulkItemRejection(error) ? 0 : consecutiveFailures + 1;
      }
    }
  }
  return outcome;
}

/** Sperrt Dokumentzeilen eines Blocks in ID-Reihenfolge (Tenant-Filter, RLS). */
export async function lockDocumentRows(
  tx: TxClient,
  tenantId: string,
  rows: readonly { id: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.$queryRaw`
    SELECT id
      FROM document
     WHERE tenant_id = ${tenantId}::uuid
       AND id = ANY(${rows.map(({ id }) => id)}::uuid[])
     ORDER BY id
       FOR UPDATE
  `;
}

/** Sperrt Ordnerzeilen eines Blocks in ID-Reihenfolge (Tenant-Filter, RLS). */
export async function lockFolderRows(
  tx: TxClient,
  tenantId: string,
  rows: readonly { id: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.$queryRaw`
    SELECT id
      FROM document_folder
     WHERE tenant_id = ${tenantId}::uuid
       AND id = ANY(${rows.map(({ id }) => id)}::uuid[])
     ORDER BY id
       FOR UPDATE
  `;
}

/** Einmal je Bulk-Action: Dokumentliste und die betroffenen Mandantenseiten. */
export function revalidateDocumentLists(clientIds: Iterable<string | null | undefined>): void {
  revalidatePath('/staff/documents');
  for (const clientId of new Set(clientIds)) {
    if (clientId) revalidatePath(`/staff/clients/${clientId}`);
  }
}

export function bulkActionError(error: string): DocumentBulkResult {
  return { ok: false, done: 0, rejected: [], error };
}

export function bulkActionResult(
  done: number,
  rejected: DocumentBulkRejection[],
  pending: string[] = [],
): DocumentBulkResult {
  return {
    ok: rejected.length === 0 && pending.length === 0,
    done,
    rejected,
    ...(pending.length > 0 ? { pending } : {}),
  };
}
