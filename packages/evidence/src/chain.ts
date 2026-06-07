// =============================================================================
// Hash-Chain-Kern: EINE Quelle der Wahrheit für die Event-Hash-Berechnung.
//
// Record (service.ts), Live-Verify (service.ts) und der Offline-Archiv-Verifier
// (archive.ts) berechnen den this_hash GENAU gleich. Daher liegt die Berechnung
// hier zentral, statt als drei handgepflegte Kopien — die genau deshalb driften
// konnten (Review F1/A2: Record hashte das Live-Objekt, Verify den jsonb-Roundtrip).
// =============================================================================

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

export interface ChainEvent {
  tenantId: string;
  /** Date (Record bzw. DB-Row) ODER bereits ein ISO-String. */
  occurredAt: Date | string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
}

/**
 * Normalisiert einen before/after-Wert auf GENAU den JSON-Roundtrip, den
 * Postgres-jsonb beim Speichern/Lesen erzeugt. Dadurch hasht der Record-Pfad
 * (Live-Objekt) identisch zum Verify-/Archiv-Pfad (jsonb-Roundtrip), unabhängig
 * vom Eingabetyp. Deckt sonst hash-brechende Fälle ab:
 *   - nicht-JSON-native Werte: Prisma.Decimal → "19.90", Buffer → {type:'Buffer',…}
 *   - undefined → null (kein gespeicherter Wert)
 * Falsy-Werte (0 / '' / false) bleiben als sie selbst erhalten (nicht zu null).
 */
export function chainValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Kanonische Event-Serialisierung (Schlüssel sortiert via canonicalJson). */
function canonicalEvent(e: ChainEvent): string {
  return canonicalJson({
    tenantId: e.tenantId,
    occurredAt: typeof e.occurredAt === 'string' ? e.occurredAt : e.occurredAt.toISOString(),
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId ?? null,
    before: chainValue(e.before),
    after: chainValue(e.after),
  });
}

/**
 * this_hash = SHA-256(prev_hash || canonicalEvent(e)). `ip`/`userAgent` fließen
 * bewusst NICHT ein (forensisches Beiwerk, kein Beweisstück). prev_hash wird als
 * Bytes/String genau so verkettet, wie er beim Record erzeugt wurde.
 */
export function eventHash(prevHash: Buffer | string, e: ChainEvent): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(Buffer.from(canonicalEvent(e), 'utf8'))
    .digest();
}
