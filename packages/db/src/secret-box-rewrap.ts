// =============================================================================
// Re-Wrap gespeicherter Secret-Box-Werte (S-08)
//
// Durchläuft alle persistenten Secret-Box-Felder (Liste aus
// `@taxtronik/crypto` SECRET_SLOTS) und lässt jeden Wert von der Secret-Box
// neu verschlüsseln: entschlüsseln mit dem Schlüsselbund, unverändert als v3
// mit dem aktiven Schlüssel und an seinen Ablageort gebunden schreiben.
//
// - Idempotent: Werte, die bereits v3 mit dem aktiven Schlüssel sind, bleiben
//   unverändert (werden aber vollständig entschlüsselt und damit geprüft).
// - Wiederaufnehmbar: jede Zeile wird einzeln per Compare-and-set
//   (`WHERE <feld> = <alter Wert>`) geschrieben und sofort committed. Ein
//   Abbruch hinterlässt nur fertig umgestellte oder unveränderte Werte; ein
//   erneuter Lauf setzt fort. Ein zwischenzeitlich von der Anwendung neu
//   geschriebener Wert wird nie überschrieben (Zähler `concurrent`).
// - Kein Klartext verlässt die Secret-Box; Fehlermeldungen enthalten nur
//   Ablageort, Tenant und Zeile.
// - Klartext, Änderungszeitpunkt und -autor der Datensätze bleiben unverändert.
//
// Die Krypto-Operationen werden injiziert (CLI: scripts/rewrap-secret-box.ts),
// damit @taxtronik/db nicht von @taxtronik/crypto abhängt.
// =============================================================================

/** Minimale SQL-Schnittstelle; `pg.Client` erfüllt sie. Ohne offene Transaktion (Autocommit). */
export interface SqlExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Ablageort, strukturgleich zu `SecretSlot` aus @taxtronik/crypto. */
export type RewrapSlot =
  | { readonly kind: 'tenant_setting'; readonly key: string; readonly field: string }
  | {
      readonly kind: 'column';
      readonly table: string;
      readonly column: string;
      readonly row: 'tenant' | 'id';
    };

/** Krypto-Operationen der Secret-Box (aus @taxtronik/crypto). */
export interface SecretBoxRewrapOps<Context> {
  contextFor(slot: RewrapSlot, ref: { tenantId: string; rowId?: string }): Context;
  looksEncrypted(value: string): boolean;
  rewrap(blob: string, context: Context): { blob: string; changed: boolean };
  describe(blob: string): { version: string; keyId: string | null };
}

export interface RewrapFailure {
  slot: string;
  tenantId: string;
  rowId: string | null;
  reason: string;
}

export interface RewrapSlotStats {
  slot: string;
  /** Gefundene nicht-leere Werte. */
  total: number;
  /** Bereits v3 mit aktivem Schlüssel. */
  current: number;
  /** In diesem Lauf umgestellt. */
  rewrapped: number;
  /** Nur bei `dryRun`: würden umgestellt. */
  pending: number;
  /** Zwischen Lesen und Schreiben von der Anwendung geändert — erneut ausführen. */
  concurrent: number;
  /** Nicht entschlüsselbar (fehlender Schlüssel, fremder Kontext, Manipulation). */
  failed: number;
  /** Kein Secret-Box-Format (z. B. Altklartext) — unverändert gelassen. */
  notEncrypted: number;
  /** Bestand vor dem Lauf je Format/Key-ID, z. B. `v2` oder `v3:<key-id>`. */
  before: Record<string, number>;
}

export interface RewrapOptions {
  dryRun?: boolean;
  batchSize?: number;
  onFailure?: (failure: RewrapFailure) => void;
}

// Nur diese Tabellen/Spalten werden als Bezeichner in SQL eingesetzt.
const SUPPORTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  n8n_connection: ['api_key_encrypted', 'signing_secret_encrypted'],
  inbound_mailbox: ['secret_enc', 'oauth_cache_enc'],
};

interface StoredValue {
  tenantId: string;
  rowId: string | null;
  cursor: string;
  secret: string;
}

interface SlotAccess {
  read(after: string | null, limit: number): Promise<StoredValue[]>;
  write(value: StoredValue, next: string): Promise<boolean>;
}

function quoted(identifier: string): string {
  return `"${identifier}"`;
}

function slotAccess(db: SqlExecutor, slot: RewrapSlot): SlotAccess {
  if (slot.kind === 'tenant_setting') {
    return {
      async read(after, limit) {
        const result = await db.query(
          `SELECT tenant_id::text AS tenant_id, value ->> $2 AS secret
             FROM public.tenant_setting
            WHERE key = $1
              AND jsonb_typeof(value -> $2) = 'string'
              AND value ->> $2 <> ''
              AND ($3::uuid IS NULL OR tenant_id > $3::uuid)
            ORDER BY tenant_id
            LIMIT $4`,
          [slot.key, slot.field, after, limit],
        );
        return (result.rows as Array<{ tenant_id: string; secret: string }>).map((row) => ({
          tenantId: row.tenant_id,
          rowId: null,
          cursor: row.tenant_id,
          secret: row.secret,
        }));
      },
      async write(value, next) {
        const result = await db.query(
          `UPDATE public.tenant_setting
              SET value = jsonb_set(value, ARRAY[$3]::text[], to_jsonb($4::text))
            WHERE tenant_id = $1::uuid AND key = $2 AND value ->> $3 = $5
            RETURNING 1 AS updated`,
          [value.tenantId, slot.key, slot.field, next, value.secret],
        );
        return result.rows.length === 1;
      },
    };
  }
  if (!SUPPORTED_COLUMNS[slot.table]?.includes(slot.column)) {
    throw new Error(`Nicht unterstützter Secret-Box-Ablageort ${slot.table}.${slot.column}.`);
  }
  const table = `public.${quoted(slot.table)}`;
  const column = quoted(slot.column);
  return {
    async read(after, limit) {
      const result = await db.query(
        `SELECT id::text AS id, tenant_id::text AS tenant_id, ${column} AS secret
           FROM ${table}
          WHERE ${column} IS NOT NULL
            AND ${column} <> ''
            AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2`,
        [after, limit],
      );
      return (result.rows as Array<{ id: string; tenant_id: string; secret: string }>).map(
        (row) => ({
          tenantId: row.tenant_id,
          rowId: row.id,
          cursor: row.id,
          secret: row.secret,
        }),
      );
    },
    async write(value, next) {
      const result = await db.query(
        `UPDATE ${table} SET ${column} = $2 WHERE id = $1::uuid AND ${column} = $3 RETURNING 1 AS updated`,
        [value.rowId, next, value.secret],
      );
      return result.rows.length === 1;
    },
  };
}

function emptyStats(slot: string): RewrapSlotStats {
  return {
    slot,
    total: 0,
    current: 0,
    rewrapped: 0,
    pending: 0,
    concurrent: 0,
    failed: 0,
    notEncrypted: 0,
    before: {},
  };
}

type RewrapDecision = { kind: 'skip' } | { kind: 'write'; blob: string };

/** Krypto-Teil: zählt den Bestand und entscheidet; wirft bei nicht entschlüsselbaren Werten. */
function decide<Context>(
  slot: RewrapSlot,
  value: StoredValue,
  ops: SecretBoxRewrapOps<Context>,
  stats: RewrapSlotStats,
): RewrapDecision {
  if (!ops.looksEncrypted(value.secret)) {
    stats.notEncrypted++;
    return { kind: 'skip' };
  }
  const described = ops.describe(value.secret);
  const label = described.keyId ? `${described.version}:${described.keyId}` : described.version;
  stats.before[label] = (stats.before[label] ?? 0) + 1;
  const context = ops.contextFor(
    slot,
    slot.kind === 'column' && slot.row === 'id'
      ? { tenantId: value.tenantId, rowId: value.rowId ?? undefined }
      : { tenantId: value.tenantId },
  );
  const result = ops.rewrap(value.secret, context);
  if (!result.changed) {
    stats.current++;
    return { kind: 'skip' };
  }
  return { kind: 'write', blob: result.blob };
}

/**
 * Stellt alle gespeicherten Werte der übergebenen Ablageorte auf v3 mit dem
 * aktiven Schlüssel um. Liefert die Zählung je Ablageort; Fehler einzelner
 * Werte brechen den Lauf nicht ab (`failed`, `onFailure`).
 */
export async function rewrapStoredSecrets<Context>(
  db: SqlExecutor,
  slots: ReadonlyArray<{ name: string; slot: RewrapSlot }>,
  ops: SecretBoxRewrapOps<Context>,
  options: RewrapOptions = {},
): Promise<RewrapSlotStats[]> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError('batchSize muss zwischen 1 und 10000 liegen.');
  }
  const report: RewrapSlotStats[] = [];
  for (const { name, slot } of slots) {
    const access = slotAccess(db, slot);
    const stats = emptyStats(name);
    let after: string | null = null;
    while (true) {
      const values = await access.read(after, batchSize);
      for (const value of values) {
        stats.total++;
        let decision: RewrapDecision;
        try {
          decision = decide(slot, value, ops, stats);
        } catch (error) {
          stats.failed++;
          options.onFailure?.({
            slot: name,
            tenantId: value.tenantId,
            rowId: value.rowId,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (decision.kind === 'skip') continue;
        if (options.dryRun) {
          stats.pending++;
          continue;
        }
        // Datenbankfehler brechen den Lauf ab; ein erneuter Lauf setzt fort.
        if (await access.write(value, decision.blob)) stats.rewrapped++;
        else stats.concurrent++;
      }
      if (values.length < batchSize) break;
      after = values[values.length - 1]!.cursor;
    }
    report.push(stats);
  }
  return report;
}
