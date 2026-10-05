// =============================================================================
// Steuertermin-Materialisierung — Web-Adapter
//
// Die eigentliche Logik lebt in @taxtronik/tax (materializeTenantTaxDeadlines)
// und ist mit dem Worker-Job (apps/worker/src/jobs/tax-deadline-materialize.ts)
// geteilt — EINE Logik, keine Drift. Hier nur die Web-Verdrahtung:
//   - withTenantContext-Tx als DB-Client (alles läuft in EINER Transaktion).
//
// Verwendung: ad-hoc nach dem Speichern einer Schedule-Config (per-Client-
// Server-Action clients/[id]/tax-schedule). P-14: Der Lauf ist auf DIESEN
// Mandanten begrenzt und legt nur dessen Termin-Kandidaten an; interne
// Vorwarnung und Auto-Anforderung bleiben dem Worker-Job vorbehalten (eigene,
// kurze Transaktionen statt einer 15-s-Web-Transaktion über den ganzen Tenant).
// Die TENANT-weite Neuberechnung („Neu berechnen" auf /staff/tax-deadlines)
// läuft ebenfalls als BullMQ-Job (P-4 — siehe server/jobs/tax-deadline-
// materialize-queue.ts).
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { materializeTenantTaxDeadlines, type MaterializeStats } from '@taxtronik/tax';

export type { MaterializeStats } from '@taxtronik/tax';

export interface MaterializeOptions {
  /** Mandant, dessen Zeitplan gespeichert wurde. */
  clientId: string;
  /** Staff-ID des Speichernden (createdBy-Feld des Kerns; hier ohne Request-Anlage). */
  systemStaffId: string;
  /** Wie weit in die Zukunft Termine erzeugt werden sollen (Default 90 Tage). */
  horizonDays?: number;
  /** Stichdatum, gegen das geprüft wird (Default: heute). */
  now?: Date;
}

function workerOnly(): never {
  // Der mandantenbezogene Kernlauf ruft diese Pfade nicht auf; falls doch,
  // lieber laut scheitern als Anforderungen in der Web-Transaktion anlegen.
  throw new Error('Vorwarnung und Auto-Anforderung laufen ausschließlich im Worker.');
}

export async function materializeClientTaxDeadlines(
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
        recordEvidence: workerOnly,
        upsertStaffNotification: workerOnly,
        resolveStaffNotifications: workerOnly,
      },
      {
        tenantId: ctx.tenantId,
        clientId: opts.clientId,
        systemStaffId: opts.systemStaffId,
        horizonDays: opts.horizonDays,
        now: opts.now,
      },
    ),
  );
}
