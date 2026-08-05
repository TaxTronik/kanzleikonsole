// =============================================================================
// Steuertermin-Materialisierung — Web-Adapter
//
// Die eigentliche Logik lebt in @taxtronik/tax (materializeTenantTaxDeadlines)
// und ist mit dem Worker-Job (apps/worker/src/jobs/tax-deadline-materialize.ts)
// geteilt — EINE Logik, keine Drift. Hier nur die Web-Verdrahtung:
//   - withTenantContext-Tx als DB-Client (alles läuft in EINER Transaktion,
//     der atomare Request-Block damit trivially atomar);
//   - evidenceService aus dem Container für den Audit-Trail.
//
// Verwendung: ad-hoc nach dem Speichern einer Schedule-Config (per-Client-
// Server-Action clients/[id]/tax-schedule). Die TENANT-weite Neuberechnung
// („Neu berechnen" auf /staff/tax-deadlines) läuft NICHT mehr hierüber,
// sondern als BullMQ-Job (P-4 — siehe server/jobs/tax-deadline-materialize-
// queue.ts und apps/worker/src/jobs/tax-deadline-materialize.ts).
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { materializeTenantTaxDeadlines, type MaterializeStats } from '@taxtronik/tax';

export type { MaterializeStats } from '@taxtronik/tax';

export interface MaterializeOptions {
  /** System-Staff-ID, die als createdBy für Auto-Anforderungen verwendet wird. */
  systemStaffId: string;
  /** Wie weit in die Zukunft Termine erzeugt werden sollen (Default 90 Tage). */
  horizonDays?: number;
  /** Stichdatum, gegen das geprüft wird (Default: heute). */
  now?: Date;
}

export async function materializeTaxDeadlines(
  ctx: TenantContext,
  opts: MaterializeOptions,
): Promise<MaterializeStats> {
  return withTenantContext(ctx, (tx) =>
    materializeTenantTaxDeadlines(
      {
        db: tx,
        // Bereits in EINER withTenantContext-Transaktion → der atomare Block
        // läuft einfach im selben Tx weiter.
        runAtomic: (fn) => fn(tx),
        recordEvidence: (etx, event) => evidenceService.record(etx, event),
        // Vorwarnungs-Notifications entstehen in DERSELBEN äußeren Tx.
        upsertStaffNotification: (ntx, input) => notify(ntx, input),
      },
      {
        tenantId: ctx.tenantId,
        systemStaffId: opts.systemStaffId,
        horizonDays: opts.horizonDays,
        now: opts.now,
      },
    ),
  );
}
