// =============================================================================
// Systemakteur des Tax-CMS je Tenant und Lease des Zustelllaufs (TCMS Stufe 4,
// ADR 0001 §3.4 des TCMS-Repos; MAIL-OUTBOX-001).
//
// Der Systemakteur ist keine Person, sondern der Zustell-Worker der
// kanzleikonsole: `knd: 'SYSTEM'`, ohne `rol` und `cli`, `sub` = feste,
// zufällige UUID je Tenant (tcms_systemakteur.akteur_id, gen_random_uuid in der
// Datenbank; nicht aus der Tenant-ID ableitbar, einmal erzeugt, per Trigger
// unveränderlich), `nam` fest. Eine erfundene Admin-Person wäre eine viel
// breitere Identität. Nur dieses Modul bildet ihn; die Web-App kann es nicht
// (Guard apps/web/src/__tests__/tcms-systemakteur-guard.test.ts, Client mit
// PERSONEN_AKTEURE), im Worker prüft tcms-systemakteur-guard.test.ts, dass nur
// hier und im Zustelljob mit ihm gearbeitet wird.
//
// Dieselbe Zeile trägt den Lease des Zustelllaufs (wie audit_anchor_lease):
// beanspruchen legt den Systemakteur beim ersten Lauf an und vergibt den Lease
// nur, wenn kein gültiger besteht – ein Lauf je Tenant gleichzeitig. Ein
// abgestürzter Halter blockiert höchstens bis `lauf_bis`. Alles über den
// Owner-Client (die App-Rolle hat auf der Tabelle keine Rechte).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TcmsAkteurAngaben } from '@taxtronik/tcms-client';

/** Bezeichnung im Audit des Tax-CMS (dort mit Präfix „System: “). */
export const TCMS_SYSTEMAKTEUR_NAME = 'Zustellung kanzleikonsole';
/** Lease-Dauer; vor jeder Mitteilung bestätigt und verlängert. */
export const TCMS_ZUSTELL_LEASE_MS = 2 * 60_000;

export type LeaseDb = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Bestätigung des Systemakteurs eines Tenants (ohne rol und cli). */
export function systemAkteur(tenantId: string, akteurId: string): TcmsAkteurAngaben {
  return { tnt: tenantId, sub: akteurId, knd: 'SYSTEM', nam: TCMS_SYSTEMAKTEUR_NAME };
}

export interface Zustelllauf {
  readonly tenantId: string;
  /** Bestätigung des Systemakteurs dieses Tenants. */
  readonly akteur: TcmsAkteurAngaben;
  /** Prüft und verlängert den Lease; false = abgelaufen oder übernommen. */
  bestaetigen(): Promise<boolean>;
  /** Gibt den eigenen Lease frei (sonst läuft er ab). */
  freigeben(): Promise<void>;
}

/**
 * Beansprucht den Zustelllauf des Tenants in einer sofort committeten
 * Anweisung und legt dabei den Systemakteur an, falls es ihn noch nicht gibt.
 * `null`: Ein anderer Lauf hält einen gültigen Lease.
 */
export async function beanspruche(
  db: LeaseDb,
  tenantId: string,
  ttlMs: number = TCMS_ZUSTELL_LEASE_MS,
): Promise<Zustelllauf | null> {
  const halter = randomUUID();
  const zeilen = await db.$queryRaw<Array<{ akteurId: string; halter: string }>>`
    INSERT INTO tcms_systemakteur (tenant_id, lauf_halter, lauf_bis)
    VALUES (
      ${tenantId}::uuid, ${halter}::uuid,
      clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'
    )
    ON CONFLICT (tenant_id) DO UPDATE
      SET lauf_halter = EXCLUDED.lauf_halter,
          lauf_bis = EXCLUDED.lauf_bis
      WHERE tcms_systemakteur.lauf_bis IS NULL
         OR tcms_systemakteur.lauf_bis <= clock_timestamp()
    RETURNING akteur_id::text AS "akteurId", lauf_halter::text AS "halter"
  `;
  const zeile = zeilen[0];
  if (!zeile || zeile.halter !== halter) return null;
  return {
    tenantId,
    akteur: systemAkteur(tenantId, zeile.akteurId),
    bestaetigen: async () =>
      (await db.$executeRaw`
        UPDATE tcms_systemakteur
           SET lauf_bis = clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'
         WHERE tenant_id = ${tenantId}::uuid
           AND lauf_halter = ${halter}::uuid
           AND lauf_bis > clock_timestamp()
      `) === 1,
    freigeben: async () => {
      await db.$executeRaw`
        UPDATE tcms_systemakteur
           SET lauf_halter = NULL, lauf_bis = NULL
         WHERE tenant_id = ${tenantId}::uuid AND lauf_halter = ${halter}::uuid
      `;
    },
  };
}
