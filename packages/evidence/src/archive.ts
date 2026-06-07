// =============================================================================
// Audit-Archive — segmentweise Auslagerung des audit_log
//
// Pure-funktionale Helfer (Serialisierung, Hash-Verifikation). Die eigentliche
// Schreib-Logik (DB + Object-Store + TSA) lebt in apps/web bzw. apps/worker, weil
// dort die Storage-Clients verfügbar sind.
//
// Datei-Format: NDJSON, eine Zeile pro Audit-Event, jede Zeile ein
// `canonical_json`-serialisiertes Objekt mit folgenden Feldern:
//
//   { "id":"123", "tenantId":"...", "occurredAt":"2025-...", "actorType":"STAFF",
//     "actorId":"...", "action":"...", "resourceType":"...", "resourceId":"...",
//     "before":..., "after":..., "ip":..., "userAgent":...,
//     "prevHash":"hex:...", "thisHash":"hex:..." }
//
// Reihenfolge: aufsteigend nach `id`. Leere optionale Felder (null/undefined)
// werden ausgelassen — siehe canonicalJson.
// =============================================================================

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import { eventHash } from './chain';

export interface ArchiveAuditRow {
  id: bigint | number;
  tenantId: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  prevHash: Buffer;
  thisHash: Buffer;
}

export interface ArchiveSerializeResult {
  ndjson: Buffer;
  fileSha256: Buffer;
  fromAuditId: bigint;
  toAuditId: bigint;
  fromOccurredAt: Date;
  toOccurredAt: Date;
  firstPrevHash: Buffer;
  lastThisHash: Buffer;
  entryCount: number;
}

/**
 * Serialisiert eine Reihe von Audit-Einträgen zu NDJSON und berechnet alle
 * Anker-Werte für die `audit_archive`-Zeile.
 */
export function serializeArchive(rows: ArchiveAuditRow[]): ArchiveSerializeResult {
  if (rows.length === 0) {
    throw new Error('serializeArchive: leere Eingabe');
  }
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(canonicalJson(rowToObject(r)));
  }
  const ndjson = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const fileSha256 = createHash('sha256').update(ndjson).digest();
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;

  return {
    ndjson,
    fileSha256,
    fromAuditId: BigInt(first.id),
    toAuditId: BigInt(last.id),
    fromOccurredAt: first.occurredAt,
    toOccurredAt: last.occurredAt,
    firstPrevHash: first.prevHash,
    lastThisHash: last.thisHash,
    entryCount: rows.length,
  };
}

/**
 * Liest eine Archiv-NDJSON-Datei zurück. Validiert pro Zeile, dass:
 *   - prev_hash dem this_hash der Vorgängerzeile entspricht
 *   - file_sha256 zum Buffer passt (vom Aufrufer separat zu prüfen)
 *
 * Wenn ok: gibt die deserialisierten Rows zurück.
 */
export interface ParsedArchiveRow {
  id: bigint;
  tenantId: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  prevHash: Buffer;
  thisHash: Buffer;
}

export function parseArchive(ndjson: Buffer): ParsedArchiveRow[] {
  const text = ndjson.toString('utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const out: ParsedArchiveRow[] = [];
  for (const l of lines) {
    const obj = JSON.parse(l) as Record<string, unknown>;
    out.push({
      id: BigInt(String(obj['id'])),
      tenantId: String(obj['tenantId']),
      occurredAt: new Date(String(obj['occurredAt'])),
      actorType: String(obj['actorType']),
      actorId: obj['actorId'] === undefined || obj['actorId'] === null ? null : String(obj['actorId']),
      action: String(obj['action']),
      resourceType: String(obj['resourceType']),
      resourceId: obj['resourceId'] === undefined || obj['resourceId'] === null ? null : String(obj['resourceId']),
      before: obj['before'] ?? null,
      after: obj['after'] ?? null,
      ip: obj['ip'] === undefined || obj['ip'] === null ? null : String(obj['ip']),
      userAgent: obj['userAgent'] === undefined || obj['userAgent'] === null ? null : String(obj['userAgent']),
      prevHash: hexFromTagged(obj['prevHash']),
      thisHash: hexFromTagged(obj['thisHash']),
    });
  }
  return out;
}

/**
 * Verifiziert: jede this_hash zeigt korrekt auf prev_hash der Folgezeile,
 * und die Hash-Ankerwerte stimmen mit den im audit_archive-Datensatz
 * gespeicherten überein.
 */
export interface ChainCheckResult {
  ok: boolean;
  brokenAtId?: bigint;
  reason?: string;
}

/**
 * Berechnet den Event-Hash über `eventHash` aus chain.ts — DIESELBE Funktion, die
 * EvidenceService.record und der Live-Verify nutzen. Damit ist eine Drift zwischen
 * Record- und Verify-Berechnung ausgeschlossen (Review F1/A2). `ip`/`userAgent`
 * fließen nicht in den Hash ein (forensisches Beiwerk, kein Beweisstück).
 */
function computeRowHash(prevHash: Buffer, r: ParsedArchiveRow): Buffer {
  return eventHash(prevHash, {
    tenantId: r.tenantId,
    occurredAt: r.occurredAt,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    before: r.before,
    after: r.after,
  });
}

export function verifyArchiveChain(
  rows: ParsedArchiveRow[],
  expected: { firstPrevHash: Buffer; lastThisHash: Buffer },
): ChainCheckResult {
  if (rows.length === 0) return { ok: false, reason: 'leeres Archiv' };
  if (!rows[0]!.prevHash.equals(expected.firstPrevHash)) {
    return { ok: false, brokenAtId: rows[0]!.id, reason: 'firstPrevHash mismatch' };
  }
  // U-4: Pro Zeile den Hash neu berechnen, um in-place-Manipulation am Event-
  // Body (before/after etc.) zu erkennen, selbst wenn prev_hash/this_hash der
  // Zeile selbst unverändert bleiben würden. Vorher prüfte der Verifier nur
  // die Kette-Linkage und vertraute auf fileSha256 — was zwar Backup-/DB-
  // Tampering abdeckt, aber bei Restore-Szenarien aus NDJSON ohne DB-
  // Referenz (Wirtschaftsprüfer mit isoliertem File) ein toter Winkel war.
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i]!;
    if (i > 0) {
      const prev = rows[i - 1]!;
      if (!cur.prevHash.equals(prev.thisHash)) {
        return { ok: false, brokenAtId: cur.id, reason: 'prev_hash zeigt nicht auf vorigen this_hash' };
      }
    }
    const computed = computeRowHash(cur.prevHash, cur);
    if (!computed.equals(cur.thisHash)) {
      return {
        ok: false,
        brokenAtId: cur.id,
        reason: 'this_hash entspricht nicht SHA-256(prev_hash || canonicalJson(event)) — Event-Body manipuliert',
      };
    }
  }
  if (!rows[rows.length - 1]!.thisHash.equals(expected.lastThisHash)) {
    return { ok: false, brokenAtId: rows[rows.length - 1]!.id, reason: 'lastThisHash mismatch' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToObject(r: ArchiveAuditRow): Record<string, unknown> {
  return {
    id: typeof r.id === 'bigint' ? r.id.toString() : String(r.id),
    tenantId: r.tenantId,
    occurredAt: r.occurredAt.toISOString(),
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    before: r.before ?? null,
    after: r.after ?? null,
    ip: r.ip,
    userAgent: r.userAgent,
    prevHash: 'hex:' + r.prevHash.toString('hex'),
    thisHash: 'hex:' + r.thisHash.toString('hex'),
  };
}

function hexFromTagged(v: unknown): Buffer {
  if (typeof v !== 'string' || !v.startsWith('hex:')) {
    throw new Error(`Erwartete hex:-getaggter Hash, bekam: ${typeof v}`);
  }
  return Buffer.from(v.slice(4), 'hex');
}
