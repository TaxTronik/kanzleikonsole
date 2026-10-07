// =============================================================================
// EvidenceService — Manipulationsevidenz für taxtronik.
//
// Schreibt Audit-Events in eine hash-verkettete, append-only Tabelle (audit_log)
// und verankert committete Präfixe zeitnah in einer zweiten RFC-3161-Kette
// (audit_anchor). Die tägliche Tages-Spitzenversiegelung bleibt zusätzlich.
//
// Mechanik:
//   this_hash = SHA-256(prev_hash || canonical_json(event))
//
// Genesis (kein Vorgänger):
//   prev_hash = SHA-256("taxtronik-genesis:" || tenant_id)
//
// Concurrency:
//   Pro-Tenant Advisory-Lock innerhalb der Transaktion serialisiert Inserts.
//
// Verifikation (CLI / Wirtschaftsprüfer):
//   verifyChain(tenantId) rechnet beide Ketten nach und prüft TSA-Stempel.
//   Der tägliche Worker prüft abschnittsweise ab Prüf-Checkpoints
//   (verifyChainSegment, verify-checkpoint.ts) mit periodischer Vollprüfung.
// =============================================================================

import { createHash } from 'node:crypto';
import type { PrismaClient, AuditActorType } from '@prisma/client';
import { eventHash, chainValue, type ChainEvent } from './chain';
import { anchorGenesisHash, anchorPayload, anchorTokenHash } from './anchor';
import type { TimestampPort } from './ports/timestamp';
import type { PersistedProgressAnchor } from './verify-status';

type Tx = Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe' | '$executeRaw'>;

/** Transaktions-Client der Evidence-Funktionen (Prisma-Client oder interaktive TX). */
export type EvidenceTx = Tx;

const GENESIS_PREFIX = Buffer.from('taxtronik-genesis:', 'utf8');

export interface AuditEventInput {
  tenantId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RecordedEvent {
  id: bigint;
  occurredAt: Date;
  prevHash: Buffer;
  thisHash: Buffer;
}

export interface AnchorLatestOptions {
  /** Reject a cryptographically valid token whose signer chain is not rooted
   * in the configured TSA trust store. Production workers set this to true. */
  requireTrustAnchor?: boolean;
  /**
   * P-05: Tenant-Lease (anchor-lease.ts). Er wird unmittelbar vor der
   * TSA-Anfrage bestätigt; ohne gültigen Lease keine Anfrage. Nach der Antwort
   * wird er erneut bestätigt, sonst wird das Token verworfen; das Insert ist
   * zusätzlich an den noch gültigen Lease gebunden.
   */
  lease?: { holder: string; confirm(): Promise<boolean> };
}

/**
 * P-05: Fehler der TSA-Anfrage oder der Prüfung ihrer Antwort. Nur diese
 * Fehler zählen für den TSA-Backoff; Datenbank- und Pool-Fehler nicht.
 */
export class TsaAnchorError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TsaAnchorError';
  }
}

export type AnchorLatestResult =
  | {
      anchored: true;
      fromAuditId: bigint;
      topAuditId: bigint;
      tsaGenTime: Date;
      trustAnchored: boolean;
    }
  | {
      anchored: false;
      reason: string;
    };

export interface VerificationResult {
  ok: boolean;
  checked: number;
  /**
   * Höchste geprüfte Audit-ID dieses Tenants (null bei leerer Kette). Dient als
   * Monotonie-Anker gegen Tail-Truncation der UNVERSIEGELTEN Spitze: schrumpft
   * dieser Wert zwischen zwei Läufen, wurden die neuesten Einträge gelöscht.
   * Robust gegen Archiv-Rotation, die nur die ältesten (niedrigen) IDs entfernt.
   */
  lastAuditId: bigint | null;
  firstBreak?: {
    auditId: bigint;
    occurredAt: Date;
    expectedHash: string;
    actualHash: string;
  };
  sealsChecked: number;
  sealBreaks: Array<{ sealDate: Date; reason: string }>;
  /**
   * Wie viele der geprüften Siegel bis zu einem hinterlegten Trust-Anchor
   * validiert haben (nur rfc3161-Adapter). Liegt der Wert unter sealsChecked,
   * sind die übrigen Siegel ungültig und erscheinen zusätzlich als Bruch.
   * `undefined`, wenn der Adapter keine Verankerungs-Auskunft liefert (local).
   */
  sealsTrustAnchored?: number;
  /** Successfully verified rolling RFC-3161 checkpoints. */
  anchorsChecked: number;
  anchorBreaks: Array<{ anchorId: bigint; topAuditId: bigint; reason: string }>;
  anchorsTrustAnchored: number;
  lastAnchorId: bigint | null;
  lastAnchoredAuditId: bigint | null;
  unanchoredEntries: number;
  oldestUnanchoredAt: Date | null;
  /** Welcher Zeitstempel-Adapter geprüft hat — IMMER ausgewiesen (Audit-Transparenz). */
  tsaMode: 'local' | 'rfc3161';
  /** Policy-Verstöße (z. B. Self-Timestamp im Produktivmodus). */
  policyBreaks: string[];
  /**
   * P-04: nur bei der checkpointgestützten Prüfung (verifyChainWithCheckpoints)
   * gesetzt — weist aus, welcher Teil in diesem Lauf neu gehasht wurde und wann
   * die Kette zuletzt vollständig ab Genesis bestätigt wurde.
   */
  incremental?: IncrementalVerificationInfo;
}

export interface IncrementalVerificationInfo {
  /**
   * 'full': In diesem Lauf wurde die Kette lückenlos ab Genesis bestätigt.
   * 'incremental': Neu gehasht wurde nur der Zuwachs ab dem Prüf-Checkpoint
   * (plus ggf. ein Abschnitt einer laufenden Vollprüfung).
   */
  mode: 'incremental' | 'full';
  /** Prüf-Checkpoint bei Laufbeginn (null = Prüfung begann bei Genesis). */
  startAuditId: bigint | null;
  /** In diesem Lauf nachgerechnete Audit-Einträge (Zuwachs und Vollprüfung). */
  rowsHashed: number;
  /** Abschluss der letzten vollständigen Prüfung ab Genesis. */
  lastFullVerifiedAt: Date | null;
  /** Fortschritt einer noch nicht abgeschlossenen Vollprüfung. */
  fullVerification: { startedAt: Date; auditId: bigint; targetAuditId: bigint } | null;
  /**
   * B15: Fortschrittsanker am Laufende für das persistierte Prüfergebnis
   * (null = keine authentischen Checkpoints mehr vorhanden).
   */
  progressAnchor?: PersistedProgressAnchor | null;
}

export interface VerifyChainOptions {
  /**
   * Wenn true UND der Adapter im 'local'-Modus läuft → harter Fail: ein
   * Self-Timestamp ist im Produktivbetrieb kein gerichtsfester Drittnachweis.
   * Default false (Lib bleibt umgebungsfrei); die Verify-Werkzeuge (CLI, täglicher
   * Worker-Check) setzen es aus NODE_ENV/EVIDENCE_REQUIRE_TSA.
   */
  requireExternalTsa?: boolean;
  /** Maximum tolerated age of the oldest locally committed but not yet
   * externally anchored row. Omit for offline/legacy verification. */
  maxUnanchoredAgeMs?: number;
}

/** Rolling-Anker ohne TSA-Antwort (P-04: Blobs werden blockweise nachgeladen). */
interface RollingAnchorMeta {
  id: bigint;
  from_audit_id: bigint;
  top_audit_id: bigint;
  top_hash: Buffer;
  previous_anchor_hash: Buffer;
  anchor_hash: Buffer;
}

interface RollingAnchorRow extends RollingAnchorMeta {
  tsa_response_blob: Buffer;
}

/**
 * P-04: Kettenposition, an der eine Prüfung fortgesetzt werden kann (persistiert
 * als Prüf-Checkpoint in `audit_verify_checkpoint`). Zähler laufen ab Genesis.
 */
export interface ChainCursor {
  /** Zuletzt geprüfte Audit-ID; 0n = vor dem ersten Eintrag. */
  auditId: bigint;
  /** Rekonstruierter Ketten-Hash an auditId (bei 0n der Genesis-Wert). */
  auditHash: Buffer;
  /** Geprüfte Audit-Einträge ab Genesis. */
  auditCount: number;
  /** Verarbeitet sind genau die Siegel mit id ≤ sealId UND top_audit_id ≤ auditId. */
  sealId: bigint;
  sealsChecked: number;
  /** null, solange der Adapter keine Verankerungs-Auskunft geliefert hat. */
  sealsTrustAnchored: number | null;
  /** Zuletzt verarbeiteter Rolling-Anker; 0n = keiner. */
  anchorId: bigint;
  /** anchor_hash des letzten gültigen Ankers = erwarteter previous_anchor_hash. */
  anchorHash: Buffer;
  /** top_audit_id des letzten gültigen Ankers (0n ohne Anker). */
  anchorTopAuditId: bigint;
  anchorsChecked: number;
  anchorsTrustAnchored: number;
}

/** Grenzen eines Prüfabschnitts; Siegel-/Anker-Grenzen VOR dem Walk ermittelt. */
export interface SegmentBounds {
  /** Inklusive Obergrenze der Audit-IDs; null = bis zum aktuellen Kettenende. */
  maxAuditId: bigint | null;
  /** Nur Siegel mit id ≤ maxSealId berücksichtigen. */
  maxSealId: bigint;
  /** Nur Rolling-Anker mit id ≤ maxAnchorId berücksichtigen. */
  maxAnchorId: bigint;
}

/** Größe eines Prüfabschnitts (je Abschnitt eine Transaktion im Worker). */
export interface SegmentLimits {
  maxRows: number;
  maxAnchors: number;
}

/**
 * Gemessen (Testcontainer, 2 Kerne): 5.000 Zeilen lesen und hashen ≈ 0,15–0,25 s,
 * eine RFC-3161-Prüfung ≈ 17 ms, 250 Anker also ≈ 4–5 s. Ein Abschnitt bleibt
 * damit weit unter dem 120-s-Transaktionsbudget des Workers.
 */
export const DEFAULT_SEGMENT_LIMITS: SegmentLimits = { maxRows: 5_000, maxAnchors: 250 };

/** Siegelbefund eines Abschnitts mit Siegel-ID und Spitze (für Checkpoint-Befunde). */
export interface SegmentSealBreak {
  sealId: bigint;
  sealDate: Date;
  topAuditId: bigint;
  reason: string;
}

export interface SegmentOutcome {
  /**
   * Fortgeschriebener Prüfstand. Bei einem Kettenbruch steht er auf der letzten
   * intakten Zeile und zählt die bis dahin geprüften Elemente.
   */
  cursor: ChainCursor;
  /**
   * false nur bei einem Hash-/Vorgängerbruch (`firstBreak`). Siegel- und
   * Ankerbefunde stoppen die Prüfung wie bei verifyChain nicht: Der Prüfstand
   * wird fortgeschrieben, die Befunde stehen in sealBreaks/anchorBreaks.
   */
  ok: boolean;
  /** Obergrenze bzw. Kettenende erreicht und alle Siegel/Anker der Grenzen verarbeitet. */
  complete: boolean;
  /** In diesem Abschnitt neu gehashte Zeilen. */
  rowsChecked: number;
  firstBreak?: NonNullable<VerificationResult['firstBreak']>;
  sealBreaks: SegmentSealBreak[];
  /**
   * Siegel, deren Spitze jenseits des geprüften Kettenendes liegt (gelöscht,
   * abgeschnitten oder nie vorhanden). Wie bei verifyChain ein Befund, aber
   * nicht als verarbeitet gezählt: Sie bleiben offen und werden an jedem
   * Kettenende erneut gemeldet. So zählen Prüfstand und Checkpoint-Abgleich
   * die Siegel nach derselben Regel (id ≤ sealId UND top_audit_id ≤ auditId).
   */
  danglingSeals: SegmentSealBreak[];
  anchorBreaks: VerificationResult['anchorBreaks'];
}

/** Prüfstand am Kettenanfang (Genesis). `sealId` bindet eine feste Siegelgrenze. */
export function genesisCursor(tenantId: string, sealId: bigint = BigInt(0)): ChainCursor {
  return {
    auditId: BigInt(0),
    auditHash: genesisHash(tenantId),
    auditCount: 0,
    sealId,
    sealsChecked: 0,
    sealsTrustAnchored: null,
    anchorId: BigInt(0),
    anchorHash: anchorGenesisHash(tenantId),
    anchorTopAuditId: BigInt(0),
    anchorsChecked: 0,
    anchorsTrustAnchored: 0,
  };
}

/** Leeres Prüfergebnis inkl. Produktiv-Policy für Self-Timestamps (R-15/P-04). */
export function createVerificationResult(
  tsaMode: VerificationResult['tsaMode'],
  opts: VerifyChainOptions,
): VerificationResult {
  const result: VerificationResult = {
    ok: true,
    checked: 0,
    lastAuditId: null,
    sealsChecked: 0,
    sealBreaks: [],
    anchorsChecked: 0,
    anchorBreaks: [],
    anchorsTrustAnchored: 0,
    lastAnchorId: null,
    lastAnchoredAuditId: null,
    unanchoredEntries: 0,
    oldestUnanchoredAt: null,
    tsaMode,
    policyBreaks: [],
  };

  // Policy: Self-Timestamp im Produktivmodus ist kein Drittnachweis → harter Fail.
  // (Der Modus wird oben unabhängig davon IMMER im Report ausgewiesen.)
  if (opts.requireExternalTsa && tsaMode === 'local') {
    result.ok = false;
    result.policyBreaks.push(
      'Self-Timestamp (LocalTimestampAdapter) im Produktivmodus unzulässig — ' +
        'externe RFC-3161-TSA erforderlich (TIMESTAMP_AUTHORITY_URL setzen).',
    );
  }
  return result;
}

export class EvidenceService {
  constructor(private readonly timestampPort: TimestampPort) {}

  /**
   * Schreibt einen Audit-Event in die Hash-Chain.
   *
   * MUSS innerhalb einer Transaktion aufgerufen werden, in der auch die
   * fachliche Schreiboperation läuft (Konsistenz garantiert).
   *
   * Beispiel:
   * ```ts
   * await prisma.$transaction(async (tx) => {
   *   const client = await tx.client.create({ data: ... });
   *   await evidence.record(tx, {
   *     tenantId, actorType: 'STAFF', actorId, action: 'client.create',
   *     resourceType: 'client', resourceId: client.id, after: client,
   *   });
   * });
   * ```
   */
  async record(tx: Tx, event: AuditEventInput): Promise<RecordedEvent> {
    // 1. Advisory-Lock pro Tenant — serialisiert Audit-Inserts.
    //    pg_advisory_xact_lock(int8): Lock wird mit Transaktions-Ende freigegeben.
    //    Der Lock-Key ist hash(audit-chain:<tenantId>) als 64-Bit-Int.
    const lockKey = computeLockKey(event.tenantId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    // 2. Vorgänger-Hash erst NACH dem Lock in einem neuen Statement holen.
    //    Unter READ COMMITTED erhält nur dieses zweite Statement einen neuen
    //    MVCC-Snapshot und sieht dadurch den Commit eines vorherigen Writers.
    const prevRows = await tx.$queryRaw<{ this_hash: Buffer }[]>`
      SELECT this_hash FROM audit_log
      WHERE tenant_id = ${event.tenantId}::uuid
      ORDER BY id DESC
      LIMIT 1
    `;
    const prevHash = prevRows[0]?.this_hash ?? genesisHash(event.tenantId);

    // 3. Event-Hash über die EINE zentrale Funktion (chain.ts) — dieselbe nutzen
    //    der Live-Verify (unten) UND der Offline-Archiv-Verifier (archive.ts),
    //    daher ist eine Drift zwischen Record- und Verify-Berechnung ausgeschlossen
    //    (Review F1/A2). chainValue normalisiert before/after auf den jsonb-
    //    Roundtrip → Record == Verify auch für Decimal/Buffer/falsy; GENAU diese
    //    normalisierte Form wird unten als jsonb gespeichert.
    const occurredAt = new Date();
    const beforeN = chainValue(event.before);
    const afterN = chainValue(event.after);
    const thisHash = eventHash(prevHash, {
      tenantId: event.tenantId,
      occurredAt,
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      before: event.before,
      after: event.after,
    });

    // 4. INSERT.
    const inserted = await tx.$queryRaw<{ id: bigint; occurred_at: Date }[]>`
      INSERT INTO audit_log (
        tenant_id, occurred_at, actor_type, actor_id, action,
        resource_type, resource_id, "before", "after", ip, user_agent,
        prev_hash, this_hash
      ) VALUES (
        ${event.tenantId}::uuid,
        ${occurredAt},
        ${event.actorType}::audit_actor_type,
        ${event.actorId}::uuid,
        ${event.action},
        ${event.resourceType},
        ${event.resourceId ?? null},
        ${beforeN === null ? null : JSON.stringify(beforeN)}::jsonb,
        ${afterN === null ? null : JSON.stringify(afterN)}::jsonb,
        ${event.ip ?? null}::inet,
        ${event.userAgent ?? null},
        ${prevHash},
        ${thisHash}
      )
      RETURNING id, occurred_at
    `;

    const row = inserted[0]!;
    return {
      id: row.id,
      occurredAt: row.occurred_at,
      prevHash,
      thisHash,
    };
  }

  /**
   * Externally anchors the latest committed local audit-chain tip.
   *
   * Deliberately runs outside the business transaction and outside the local
   * audit advisory lock. New audit events can therefore be appended while the
   * TSA request is in flight. The selected top remains a valid prefix and a
   * later run anchors the newer tail.
   *
   * Concurrent workers may request the same/different tip. The conditional
   * INSERT accepts only the worker whose previous anchor is still current.
   * Additionally, UNIQUE(tenant_id, previous_anchor_hash) permits exactly one
   * successor per external predecessor even when concurrent statements share
   * an MVCC snapshot. Losers discard their token and retry; no branch can enter
   * the persisted external anchor chain.
   */
  async anchorLatest(
    tx: Tx,
    tenantId: string,
    opts: AnchorLatestOptions = {},
  ): Promise<AnchorLatestResult> {
    if (this.timestampPort.mode !== 'rfc3161') {
      return { anchored: false, reason: 'keine externe RFC-3161-TSA konfiguriert' };
    }

    const previousRows = await tx.$queryRaw<
      Array<{ id: bigint; top_audit_id: bigint; anchor_hash: Buffer }>
    >`
      SELECT id, top_audit_id, anchor_hash
      FROM audit_anchor
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id DESC
      LIMIT 1
    `;
    const previous = previousRows[0];
    const previousTopAuditId = previous?.top_audit_id ?? BigInt(0);
    const previousAnchorHash = previous
      ? Buffer.from(previous.anchor_hash)
      : anchorGenesisHash(tenantId);

    const pendingRows = await tx.$queryRaw<
      Array<{ from_audit_id: bigint; top_audit_id: bigint; top_hash: Buffer }>
    >`
      WITH pending AS (
        SELECT id, this_hash
        FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid
          AND id > ${previousTopAuditId}
      )
      SELECT
        (SELECT id FROM pending ORDER BY id ASC LIMIT 1) AS from_audit_id,
        (SELECT id FROM pending ORDER BY id DESC LIMIT 1) AS top_audit_id,
        (SELECT this_hash FROM pending ORDER BY id DESC LIMIT 1) AS top_hash
      WHERE EXISTS (SELECT 1 FROM pending)
    `;
    const pending = pendingRows[0];
    if (!pending) return { anchored: false, reason: 'keine unverankerten Audit-Einträge' };

    const payload = anchorPayload({
      tenantId,
      fromAuditId: pending.from_audit_id,
      topAuditId: pending.top_audit_id,
      topHash: pending.top_hash,
      previousAnchorHash,
    });
    // P-05: Nur mit frisch bestätigtem Lease fragen; zwischen zwei Läufen liegt
    // damit stets eine abgeschlossene Anfrage (TSA-Timeout 10 s < Lease-Dauer).
    if (opts.lease && !(await opts.lease.confirm())) {
      return { anchored: false, reason: ANCHOR_LEASE_LOST_REASON };
    }
    const { requestBlob, serial, response, verified, tsaGenTime } = await this.stampAndVerify(
      payload,
      opts,
    );
    // Eine Antwort, die erst nach Ablauf des Leases eintrifft, nie speichern:
    // Ein anderer Lauf kann ihn inzwischen übernommen haben. Das Insert bleibt
    // zusätzlich an den gültigen Lease gebunden (kein Fenster bis zum Insert).
    if (opts.lease && !(await opts.lease.confirm())) {
      return { anchored: false, reason: ANCHOR_LEASE_EXPIRED_REASON };
    }
    const nextAnchorHash = anchorTokenHash(response);

    const inserted = await tx.$executeRaw`
      INSERT INTO audit_anchor (
        tenant_id, from_audit_id, top_audit_id, top_hash,
        previous_anchor_hash, anchor_hash,
        tsa_request_blob, tsa_response_blob, tsa_serial, tsa_gen_time,
        trust_anchored
      )
      SELECT
        ${tenantId}::uuid,
        ${pending.from_audit_id},
        ${pending.top_audit_id},
        ${pending.top_hash},
        ${previousAnchorHash},
        ${nextAnchorHash},
        ${requestBlob},
        ${response},
        ${serial},
        ${tsaGenTime},
        ${verified.trustAnchored}
      WHERE COALESCE(
        (SELECT top_audit_id FROM audit_anchor
         WHERE tenant_id = ${tenantId}::uuid ORDER BY id DESC LIMIT 1),
        0
      ) = ${previousTopAuditId}
        AND NOT EXISTS (
          SELECT 1 FROM audit_anchor
          WHERE tenant_id = ${tenantId}::uuid
            AND top_audit_id = ${pending.top_audit_id}
        )
        AND (
          ${opts.lease?.holder ?? null}::uuid IS NULL
          OR EXISTS (
            SELECT 1 FROM audit_anchor_lease
            WHERE tenant_id = ${tenantId}::uuid
              AND holder = ${opts.lease?.holder ?? null}::uuid
              AND expires_at > clock_timestamp()
          )
        )
      ON CONFLICT DO NOTHING
    `;
    if (inserted === 0) {
      return {
        anchored: false,
        reason: 'paralleler Anchor-Lauf war schneller; neuer Versuch folgt',
      };
    }

    return {
      anchored: true,
      fromAuditId: pending.from_audit_id,
      topAuditId: pending.top_audit_id,
      tsaGenTime,
      trustAnchored: verified.trustAnchored,
    };
  }

  /**
   * TSA-Anfrage und Prüfung der Antwort. Jeder Fehler hier ist ein
   * TsaAnchorError (zählt für den TSA-Backoff), kein Datenbankfehler.
   */
  private async stampAndVerify(
    payload: Uint8Array,
    opts: AnchorLatestOptions,
  ): Promise<{
    requestBlob: Buffer;
    serial: string | null;
    response: Buffer;
    verified: { ok: boolean; trustAnchored: boolean };
    tsaGenTime: Date;
  }> {
    try {
      const stamp = await this.timestampPort.timestamp(payload);
      if (!stamp.tsaRequestBlob || !stamp.tsaResponseBlob) {
        throw new Error('RFC-3161-TSA lieferte keinen vollständigen Request-/Response-Nachweis.');
      }
      const response = Buffer.from(stamp.tsaResponseBlob);
      const verified = this.timestampPort.verifyDetailed
        ? await this.timestampPort.verifyDetailed(payload, response)
        : { ok: await this.timestampPort.verify(payload, response), trustAnchored: false };
      if (!verified.ok) {
        throw new Error('RFC-3161-Token konnte nicht gegen den Rolling-Anchor verifiziert werden.');
      }
      if (opts.requireTrustAnchor && !verified.trustAnchored) {
        throw new Error('RFC-3161-Token ist kryptografisch gültig, aber nicht trust-verankert.');
      }
      const tsaGenTime = new Date(stamp.timestampedAt);
      if (Number.isNaN(tsaGenTime.getTime())) {
        throw new Error('RFC-3161-Token enthält keine gültige TSA-genTime.');
      }
      return {
        requestBlob: Buffer.from(stamp.tsaRequestBlob),
        serial: stamp.tsaSerial ?? null,
        response,
        verified,
        tsaGenTime,
      };
    } catch (error) {
      throw error instanceof TsaAnchorError ? error : new TsaAnchorError(error);
    }
  }

  /**
   * Versiegelt den Tages-Spitzen-Hash mit RFC-3161 (oder lokalem Self-Timestamp).
   * Wird vom Worker täglich aufgerufen (Job `evidence:seal:daily`).
   *
   * Idempotent: Doppel-Aufruf für dasselbe (tenant, sealDate) ist No-Op.
   *
   * RF-4: Braucht bewusst KEINE umgebende Transaktion. Der TSA-Call (Schritt 3,
   * HTTP mit 10-s-Timeout) riss vorher das interaktive 5-s-Prisma-TX-Timeout
   * (P2028). Korrektheit ohne TX: versiegelt werden nur abgeschlossene
   * Vergangenheitstage (sealDate < heute, UTC), und record() schreibt
   * occurred_at = now() — zwischen Top-Lookup (Schritt 2) und INSERT (Schritt 4)
   * können also keine neuen audit_log-Zeilen für den Zieltag mehr entstehen;
   * der gestempelte Hash bleibt der Tages-Spitzen-Hash. Parallele Doppelläufe
   * fängt der Unique-Constraint (tenant_id, seal_date) + ON CONFLICT DO NOTHING.
   */
  async sealDay(
    tx: Tx,
    tenantId: string,
    sealDate: Date,
  ): Promise<{ sealed: boolean; reason?: string }> {
    // 1. Bereits versiegelt?
    const existing = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
        AND seal_date = ${dateOnly(sealDate)}::date
      LIMIT 1
    `;
    if (existing.length > 0) {
      return { sealed: false, reason: 'bereits versiegelt' };
    }

    // 2. Top-Eintrag des Tages holen. RF-6: explizite UTC-Halboffen-Range
    //    statt `occurred_at::date = …` — der ::date-Cast hängt seit der
    //    timestamptz-Umstellung (iter77) von der DB-Session-TZ ab und ist
    //    nicht index-fähig; die Range nutzt den (tenant_id, occurred_at)-Index.
    const dayStartUtc = new Date(`${dateOnly(sealDate)}T00:00:00.000Z`);
    const nextDayStartUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);
    const top = await tx.$queryRaw<{ id: bigint; this_hash: Buffer }[]>`
      SELECT id, this_hash FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND occurred_at >= ${dayStartUtc}
        AND occurred_at < ${nextDayStartUtc}
      ORDER BY id DESC
      LIMIT 1
    `;
    if (top.length === 0) {
      return { sealed: false, reason: 'kein Audit-Event an diesem Tag' };
    }
    const topRow = top[0]!;

    // 3. RFC-3161-Stempel holen (HTTP — deshalb läuft sealDay außerhalb
    //    einer Transaktion, siehe Methodenkommentar).
    const stamp = await this.timestampPort.timestamp(topRow.this_hash);

    // Eine HTTP-200-Antwort ist noch kein vertrauenswürdiger Zeitstempel. Vor
    // dem Persistieren dieselbe Signatur-/Imprint-/Trust-Anchor-Prüfung wie bei
    // der späteren Chain-Verifikation erzwingen; sonst würde die UI bis zum
    // nächsten Prüflauf ein untrusted Token als „versiegelt“ ausweisen.
    const response = stamp.tsaResponseBlob ? Buffer.from(stamp.tsaResponseBlob) : null;
    const stampValid = await this.timestampPort.verify(topRow.this_hash, response);
    if (!stampValid) {
      throw new Error('Zeitstempel-Antwort konnte nicht vertrauenswürdig verifiziert werden.');
    }

    // 4. INSERT — ON CONFLICT DO NOTHING macht parallele Doppelläufe harmlos.
    const insertedCount = await tx.$executeRaw`
      INSERT INTO audit_seal (
        tenant_id, seal_date, top_audit_id, top_hash,
        tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at, sealed_by
      ) VALUES (
        ${tenantId}::uuid,
        ${dateOnly(sealDate)}::date,
        ${topRow.id},
        ${topRow.this_hash},
        ${stamp.tsaRequestBlob ? Buffer.from(stamp.tsaRequestBlob) : null},
        ${stamp.tsaResponseBlob ? Buffer.from(stamp.tsaResponseBlob) : null},
        ${stamp.tsaSerial},
        ${new Date(stamp.timestampedAt)},
        ${'system'}
      )
      ON CONFLICT (tenant_id, seal_date) DO NOTHING
    `;
    if (insertedCount === 0) {
      return { sealed: false, reason: 'bereits versiegelt (paralleler Lauf)' };
    }

    return { sealed: true };
  }

  /**
   * Rechnet die Hash-Chain für einen Tenant nach und prüft alle Tages-Stempel.
   * Wird von der CLI (`pnpm verify:chain`) und vom Admin-UI aufgerufen.
   */
  async verifyChain(
    tx: Tx,
    tenantId: string,
    opts: VerifyChainOptions = {},
  ): Promise<VerificationResult> {
    const result = this.newVerificationResult(opts);

    // Seals VORAB laden — ihre top_audit_id steuert, welchen rekonstruierten
    // Ketten-Hash wir während des Walks festhalten müssen (Punkt 2: der TSA-
    // Imprint wird gegen DIESEN Wert geprüft, nie gegen die gespeicherte Spalte).
    const seals = await tx.$queryRaw<SealRow[]>`
      SELECT seal_date, top_audit_id, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY seal_date ASC
    `;
    const sealTopIds = new Set<bigint>(seals.map((s) => s.top_audit_id));
    // P-04: nur Anker-Metadaten vorab; die mehrere KB großen TSA-Antworten
    // lädt verifyRollingAnchors blockweise (vorher alle Blobs in einer Abfrage).
    const anchors = await tx.$queryRaw<RollingAnchorMeta[]>`
      SELECT id, from_audit_id, top_audit_id, top_hash,
             previous_anchor_hash, anchor_hash
      FROM audit_anchor
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id ASC
    `;
    const anchorTopIds = new Set<bigint>(anchors.map((a) => a.top_audit_id));
    const lastAnchoredAuditId = initializeAnchorSummary(result, anchors);
    const recomputedTops = new Map<bigint, Buffer>();

    // 1. Audit-Chain durchgehen (gemeinsamer Walker, R-15). RF-5: cursor-basiert
    //    in 1000er-Chunks nach id; der Walk läuft strikt id-aufsteigend über ALLE
    //    Zeilen des Tenants. Den AUS DER KETTE REKONSTRUIERTEN Spitzen-Hash
    //    versiegelter/verankerter Einträge festhalten — er (nicht die DB-Spalte)
    //    ist der Prüfwert unten.
    const walk = await walkChain(
      tx,
      tenantId,
      { afterAuditId: BigInt(-1), expectedPrev: genesisHash(tenantId) },
      (row, computed) =>
        trackAuditCheckpoint(
          result,
          recomputedTops,
          sealTopIds,
          anchorTopIds,
          lastAnchoredAuditId,
          row,
          computed,
        ),
    );
    result.checked = walk.checked;
    result.lastAuditId = walk.lastAuditId;
    if (walk.firstBreak) {
      result.ok = false;
      result.firstBreak = walk.firstBreak;
      return result;
    }

    // 2. Tages-Stempel verifizieren — gegen den REKONSTRUIERTEN Ketten-Hash.
    //    NIE gegen audit_seal.top_hash (gespeicherte Spalte): das wäre DB-gegen-DB
    //    und ließe einen Angreifer, der die History konsistent umschreibt, passieren.
    //    Der Prüfwert kommt ausschließlich aus dem SHA-256-Walk oben.
    await this.verifySeals(seals, recomputedTops, result, FULL_CHAIN_SEAL_REASONS);

    await this.verifyRollingAnchors(tx, tenantId, anchors, recomputedTops, result);
    applyUnanchoredAgePolicy(result, opts.maxUnanchoredAgeMs);

    return result;
  }

  /** Zeitstempel-Modus des Adapters (für Prüfergebnisse außerhalb der Klasse). */
  get tsaMode(): VerificationResult['tsaMode'] {
    return this.timestampPort.mode;
  }

  /** Leeres Prüfergebnis inkl. Produktiv-Policy für Self-Timestamps (R-15). */
  private newVerificationResult(opts: VerifyChainOptions): VerificationResult {
    return createVerificationResult(this.timestampPort.mode, opts);
  }

  /**
   * Gemeinsame Siegelprüfung von verifyChain und verifyRecoverySegment (R-15).
   * Jedes Siegel wird gegen den im Walk REKONSTRUIERTEN Spitzen-Hash geprüft:
   * fehlender Spitzen-Eintrag, abweichende Spalte und gescheiterte TSA-Bindung
   * sind Brüche; nur der Begründungstext hängt vom Prüfkontext ab.
   */
  private async verifySeals(
    seals: SealRow[],
    recomputedTops: Map<bigint, Buffer>,
    result: SealTally,
    reasons: SealBreakReasons,
  ): Promise<void> {
    for (const s of seals) {
      await this.verifySeal(s, recomputedTops.get(s.top_audit_id), result, reasons);
    }
  }

  /** Prüft EIN Siegel gegen den rekonstruierten Spitzen-Hash (undefined = fehlt). */
  private async verifySeal(
    s: SealRow,
    recomputed: Buffer | undefined,
    result: SealTally,
    reasons: SealBreakReasons,
  ): Promise<void> {
    result.sealsChecked++;
    if (!recomputed) {
      // Der versiegelte Spitzen-Eintrag existiert nicht mehr in der rekonstruierten
      // Kette (gelöscht/abgeschnitten) — der Stempel hängt in der Luft.
      result.ok = false;
      result.sealBreaks.push({ sealDate: s.seal_date, reason: reasons.missing(s.top_audit_id) });
      return;
    }
    // Spalten-Integrität: gespeicherter top_hash MUSS dem rekonstruierten Hash
    // entsprechen. Fängt DB-Manipulation auch dann, wenn ein lokaler Adapter
    // keinen kryptografischen verify() leistet (verify() gibt dort immer true).
    if (!recomputed.equals(Buffer.from(s.top_hash))) {
      result.ok = false;
      result.sealBreaks.push({ sealDate: s.seal_date, reason: reasons.topHashMismatch });
      return;
    }
    // TSA-Bindung: der messageImprint im Token muss an den rekonstruierten Hash
    // binden. Schlägt fehl, sobald die History umgeschrieben wurde (Token trägt
    // den alten Imprint, die Kette rechnet jetzt einen anderen Spitzen-Hash).
    const sealRes = await this.verifySealBinding(
      recomputed,
      s.tsa_response_blob ? Buffer.from(s.tsa_response_blob) : null,
    );
    if (sealRes.trustAnchored !== null) {
      result.sealsTrustAnchored =
        (result.sealsTrustAnchored ?? 0) + (sealRes.trustAnchored ? 1 : 0);
    }
    if (!sealRes.ok) {
      result.ok = false;
      result.sealBreaks.push({ sealDate: s.seal_date, reason: reasons.tsaFailed });
    }
  }

  /**
   * Prüft die TSA-Bindung eines Siegels an den rekonstruierten Spitzen-Hash.
   * Nutzt verifyDetailed (Verankerungs-Auskunft) falls der Adapter es anbietet,
   * sonst verify(). `trustAnchored` ist null, wenn keine Auskunft möglich ist.
   */
  private async verifySealBinding(
    recomputed: Buffer,
    blob: Buffer | null,
  ): Promise<{ ok: boolean; trustAnchored: boolean | null }> {
    const port = this.timestampPort;
    if (port.verifyDetailed) {
      const r = await port.verifyDetailed(recomputed, blob);
      return { ok: r.ok, trustAnchored: r.trustAnchored };
    }
    return { ok: await port.verify(recomputed, blob), trustAnchored: null };
  }

  /**
   * Verifies the sparse external chain against reconstructed local tips.
   * P-04: TSA responses are loaded in id ranges of ANCHOR_BATCH_SIZE instead of
   * one query for all blobs; order and checks are unchanged.
   */
  private async verifyRollingAnchors(
    tx: Tx,
    tenantId: string,
    anchors: RollingAnchorMeta[],
    recomputedTops: Map<bigint, Buffer>,
    result: VerificationResult,
  ): Promise<void> {
    const state: AnchorChainState = {
      expectedPreviousAnchorHash: anchorGenesisHash(tenantId),
      previousTopAuditId: BigInt(0),
    };
    for (let i = 0; i < anchors.length; i += ANCHOR_BATCH_SIZE) {
      const batch = anchors.slice(i, i + ANCHOR_BATCH_SIZE);
      const blobs = await fetchAnchorBlobs(tx, tenantId, batch);
      for (const anchor of batch) {
        await this.verifyRollingAnchor(
          tenantId,
          withBlob(anchor, blobs),
          recomputedTops.get(anchor.top_audit_id),
          state,
          result,
        );
      }
    }
  }

  /**
   * Prüft EINEN Rolling-Anker gegen den rekonstruierten lokalen Spitzen-Hash
   * (undefined = Spitzen-Eintrag fehlt). Die externe Vorgängerkette (`state`)
   * wird nur bei Erfolg fortgeschrieben; ein Bruch lässt sie auf dem letzten
   * gültigen Anker stehen.
   */
  private async verifyRollingAnchor(
    tenantId: string,
    anchor: RollingAnchorRow,
    recomputed: Buffer | undefined,
    state: AnchorChainState,
    result: AnchorTally,
  ): Promise<void> {
    result.anchorsChecked++;
    const structuralError = anchorStructureError(
      anchor,
      state.previousTopAuditId,
      state.expectedPreviousAnchorHash,
    );
    if (structuralError) {
      addAnchorBreak(result, anchor, structuralError);
      return;
    }

    const localTipError = anchorLocalTipError(anchor, recomputed);
    if (localTipError || !recomputed) {
      addAnchorBreak(result, anchor, localTipError ?? 'verankerter Spitzen-Eintrag fehlt');
      return;
    }

    const response = Buffer.from(anchor.tsa_response_blob);
    const computedAnchorHash = anchorTokenHash(response);
    if (!computedAnchorHash.equals(Buffer.from(anchor.anchor_hash))) {
      addAnchorBreak(
        result,
        anchor,
        'anchor_hash stimmt nicht mit dem gespeicherten TSA-Token überein',
      );
      return;
    }
    const payload = anchorPayload({
      tenantId,
      fromAuditId: anchor.from_audit_id,
      topAuditId: anchor.top_audit_id,
      topHash: recomputed,
      previousAnchorHash: state.expectedPreviousAnchorHash,
    });
    const verification = await this.verifySealBinding(payload, response);
    if (!verification.ok) {
      addAnchorBreak(result, anchor, 'RFC-3161-Verifikation des Rolling-Ankers fehlgeschlagen');
      return;
    }
    if (verification.trustAnchored) result.anchorsTrustAnchored++;

    state.expectedPreviousAnchorHash = computedAnchorHash;
    state.previousTopAuditId = anchor.top_audit_id;
  }

  /**
   * Prüft eine bewusst neu gestartete Teilkette ab einem Recovery-Checkpoint.
   *
   * Der historische Bruch davor bleibt bestehen. Für den Checkpoint selbst wird
   * der gespeicherte `prev_hash` als neuer Vertrauensanker verwendet; ab dort
   * wird jede Zeile wieder normal per SHA-256-Walk geprüft. Damit kann die UI
   * ehrlich ausweisen: "historisch unterbrochen, ab Audit-ID X wieder fortlaufend
   * geprüft", ohne den alten Zeitraum grünzuwaschen.
   */
  async verifyRecoverySegment(
    tx: Tx,
    tenantId: string,
    checkpointAuditId: bigint,
    opts: VerifyChainOptions = {},
  ): Promise<VerificationResult> {
    // Bewusst wie bisher: Die Recovery-Teilkette prüft Hash-Kette und Siegel ab
    // dem Checkpoint, aber weder Rolling-Anker noch maxUnanchoredAgeMs (R-15:
    // nur gemeinsamer Walker/Siegelprüfung, keine Änderung des Prüfumfangs).
    const result = this.newVerificationResult(opts);

    const anchor = await tx.$queryRaw<Array<{ id: bigint; prev_hash: Buffer; occurred_at: Date }>>`
      SELECT id, prev_hash, occurred_at
      FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND id = ${checkpointAuditId}
      LIMIT 1
    `;
    if (anchor.length === 0) {
      result.ok = false;
      result.policyBreaks.push(
        `Recovery-Checkpoint Audit-ID ${checkpointAuditId} existiert nicht mehr.`,
      );
      return result;
    }

    const seals = await tx.$queryRaw<SealRow[]>`
      SELECT seal_date, top_audit_id, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
        AND top_audit_id >= ${checkpointAuditId}
      ORDER BY seal_date ASC
    `;
    const sealTopIds = new Set<bigint>(seals.map((s) => s.top_audit_id));
    const recomputedTops = new Map<bigint, Buffer>();

    // Gemeinsamer Walker (R-15) ab dem Checkpoint; der gespeicherte prev_hash
    // des Checkpoints ist der neue Vertrauensanker.
    const walk = await walkChain(
      tx,
      tenantId,
      {
        afterAuditId: checkpointAuditId - BigInt(1),
        expectedPrev: Buffer.from(anchor[0]!.prev_hash),
      },
      (row, computed) => {
        if (sealTopIds.has(row.id)) recomputedTops.set(row.id, computed);
      },
    );
    result.checked = walk.checked;
    result.lastAuditId = walk.lastAuditId;
    if (walk.firstBreak) {
      result.ok = false;
      result.firstBreak = walk.firstBreak;
      return result;
    }

    await this.verifySeals(seals, recomputedTops, result, RECOVERY_SEAL_REASONS);

    return result;
  }

  /**
   * P-04: prüft einen Abschnitt der Gesamtkette ab einem Prüfstand (`start`).
   *
   * Dieselben Prüfungen wie verifyChain — Vorgänger-Link und Ereignis-Hash
   * jeder Zeile, Siegel und Rolling-Anker gegen den REKONSTRUIERTEN Hash,
   * externe Vorgängerkette —, aber begrenzt auf `limits` je Abschnitt, damit
   * jeder Abschnitt in einer eigenen kurzen Transaktion läuft. Rolling-Anker
   * werden blockweise per id-Cursor geladen; ein voller Ankerblock begrenzt den
   * Walk auf seinen höchsten Spitzen-Eintrag.
   *
   * Verarbeitet werden genau die Elemente zwischen altem und neuem Prüfstand:
   * Zeilen mit start.auditId < id ≤ neuer auditId; Siegel mit id ≤ maxSealId,
   * deren Spitze im gelesenen Bereich liegt, sowie nachträglich angelegte
   * Siegel (id > start.sealId) mit Spitze unterhalb von start.auditId; Anker in
   * id-Reihenfolge bis maxAnchorId. Spitzen unterhalb von start.auditId stammen
   * aus einem früheren Walk und werden per Einzel-Nachrechnung bestätigt.
   * Siegel mit Spitze jenseits des gelesenen Kettenendes werden nur gemeldet
   * (`danglingSeals`), nicht als verarbeitet gezählt.
   */
  async verifyChainSegment(
    tx: Tx,
    tenantId: string,
    start: ChainCursor,
    bounds: SegmentBounds,
    limits: SegmentLimits = DEFAULT_SEGMENT_LIMITS,
  ): Promise<SegmentOutcome> {
    if (limits.maxRows < 1 || limits.maxAnchors < 1) {
      throw new RangeError('Prüfabschnitte brauchen mindestens eine Zeile und einen Anker.');
    }
    const cursor: ChainCursor = { ...start };
    const outcome: SegmentOutcome = {
      cursor,
      ok: true,
      complete: false,
      rowsChecked: 0,
      sealBreaks: [],
      danglingSeals: [],
      anchorBreaks: [],
    };

    // 1. Nächster Ankerblock (nur Metadaten) und daraus die Walk-Grenze.
    const anchors = await fetchAnchorMetaAfter(
      tx,
      tenantId,
      start.anchorId,
      bounds.maxAnchorId,
      limits.maxAnchors,
    );
    const limit = segmentWalkLimit(anchors, bounds, limits);

    // 2. Walk ab dem Prüfstand; jeder rekonstruierte Hash des Abschnitts bleibt
    //    für Siegel/Anker verfügbar (höchstens limits.maxRows Einträge).
    const recomputed = new Map<bigint, Buffer>();
    const walk = await walkChain(
      tx,
      tenantId,
      { afterAuditId: start.auditId, expectedPrev: start.auditHash },
      (row, computed) => recomputed.set(row.id, computed),
      { maxRows: limits.maxRows, untilAuditId: limit.until },
    );
    outcome.rowsChecked = walk.checked;
    cursor.auditId = walk.lastAuditId ?? start.auditId;
    cursor.auditHash = walk.lastHash;
    cursor.auditCount = start.auditCount + walk.checked;
    if (walk.firstBreak) {
      outcome.ok = false;
      outcome.firstBreak = walk.firstBreak;
      return outcome;
    }

    const scope: SegmentScope = {
      below: start.auditId,
      // Abschließend gelesen bis hier (null = Kettenende): Spitzen in diesem
      // Bereich ohne gelesene Zeile fehlen tatsächlich.
      coveredUpTo: walk.exhausted ? limit.until : cursor.auditId,
      segmentEnd: walk.exhausted && !limit.anchorLimited,
      recomputed,
    };
    // 3. Siegel, 4. Rolling-Anker; false = Bruch unterhalb des Prüfstands.
    if (!(await this.verifySegmentSeals(tx, tenantId, scope, bounds, outcome))) return outcome;
    if (!(await this.verifySegmentAnchors(tx, tenantId, scope, anchors, outcome))) return outcome;

    // Am Abschnittsende sind alle geladenen Anker verarbeitet; ein voller Block
    // kann weitere Anker haben, die der nächste Abschnitt lädt.
    outcome.complete = scope.segmentEnd && !limit.anchorBatchFull;
    return outcome;
  }

  /**
   * Siegel eines Abschnitts in Datumsreihenfolge wie verifyChain; false =
   * Kettenbruch unterhalb des Prüfstands. Siegelbefunde stoppen nicht.
   */
  private async verifySegmentSeals(
    tx: Tx,
    tenantId: string,
    scope: SegmentScope,
    bounds: SegmentBounds,
    outcome: SegmentOutcome,
  ): Promise<boolean> {
    const cursor = outcome.cursor;
    const seals = await fetchSegmentSeals(tx, tenantId, {
      below: scope.below,
      upTo: scope.segmentEnd ? null : scope.coveredUpTo,
      sealIdAfter: cursor.sealId,
      maxSealId: bounds.maxSealId,
    });
    const tally: SealTally = {
      ok: true,
      sealsChecked: cursor.sealsChecked,
      sealsTrustAnchored: cursor.sealsTrustAnchored ?? undefined,
      sealBreaks: [],
    };
    for (const seal of seals) {
      const hash = await segmentHashAt(tx, tenantId, scope, seal.top_audit_id, outcome);
      if (hash === 'broken') return false;
      if (hash === undefined && seal.top_audit_id > cursor.auditId) {
        // Spitze jenseits des gelesenen Kettenendes: Befund wie verifyChain,
        // aber nicht gezählt; das Siegel bleibt offen (siehe danglingSeals).
        outcome.danglingSeals.push({
          sealId: seal.id,
          sealDate: seal.seal_date,
          topAuditId: seal.top_audit_id,
          reason: FULL_CHAIN_SEAL_REASONS.missing(seal.top_audit_id),
        });
        continue;
      }
      const before = tally.sealBreaks.length;
      await this.verifySeal(seal, hash, tally, FULL_CHAIN_SEAL_REASONS);
      // Befund mit Siegel-ID und Spitze festhalten; er stoppt die Prüfung nicht.
      const found = tally.sealBreaks[before];
      if (found) {
        outcome.sealBreaks.push({
          sealId: seal.id,
          sealDate: found.sealDate,
          topAuditId: seal.top_audit_id,
          reason: found.reason,
        });
      }
    }
    if (bounds.maxSealId > cursor.sealId) cursor.sealId = bounds.maxSealId;
    cursor.sealsChecked = tally.sealsChecked;
    cursor.sealsTrustAnchored = tally.sealsTrustAnchored ?? null;
    return true;
  }

  /**
   * Rolling-Anker eines Abschnitts in id-Reihenfolge; false = Kettenbruch
   * unterhalb des Prüfstands. Ankerbefunde stoppen nicht; die externe
   * Vorgängerkette bleibt wie bei verifyChain auf dem letzten gültigen Anker.
   */
  private async verifySegmentAnchors(
    tx: Tx,
    tenantId: string,
    scope: SegmentScope,
    anchors: RollingAnchorMeta[],
    outcome: SegmentOutcome,
  ): Promise<boolean> {
    const cursor = outcome.cursor;
    const due = dueAnchors(anchors, scope);
    const blobs = await fetchAnchorBlobs(tx, tenantId, due);
    const state: AnchorChainState = {
      expectedPreviousAnchorHash: cursor.anchorHash,
      previousTopAuditId: cursor.anchorTopAuditId,
    };
    const tally: AnchorTally = {
      ok: true,
      anchorsChecked: cursor.anchorsChecked,
      anchorsTrustAnchored: cursor.anchorsTrustAnchored,
      anchorBreaks: outcome.anchorBreaks,
    };
    for (const anchor of due) {
      const hash = await segmentHashAt(tx, tenantId, scope, anchor.top_audit_id, outcome);
      if (hash === 'broken') return false;
      await this.verifyRollingAnchor(tenantId, withBlob(anchor, blobs), hash, state, tally);
      cursor.anchorId = anchor.id;
    }
    cursor.anchorHash = state.expectedPreviousAnchorHash;
    cursor.anchorTopAuditId = state.previousTopAuditId;
    cursor.anchorsChecked = tally.anchorsChecked;
    cursor.anchorsTrustAnchored = tally.anchorsTrustAnchored;
    return true;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Bereich, den ein Prüfabschnitt abschließend gelesen hat (P-04). */
interface SegmentScope {
  /** Prüfstand vor dem Abschnitt; Spitzen ≤ below stammen aus früheren Walks. */
  below: bigint;
  /** Abschließend gelesen bis hier; null = Kettenende. */
  coveredUpTo: bigint | null;
  /** Obergrenze bzw. Kettenende erreicht: Spitzen dahinter fehlen. */
  segmentEnd: boolean;
  /** Im Abschnitt rekonstruierte Hashes je Audit-ID. */
  recomputed: Map<bigint, Buffer>;
}

/**
 * Walk-Grenze eines Abschnitts: Ist der Ankerblock voll, endet der Walk an
 * seinem höchsten Spitzen-Eintrag, damit jeder geladene Anker im selben
 * Abschnitt geprüft werden kann und keiner zur Einzel-Nachrechnung abrutscht.
 */
function segmentWalkLimit(
  anchors: RollingAnchorMeta[],
  bounds: SegmentBounds,
  limits: SegmentLimits,
): { until: bigint | null; anchorLimited: boolean; anchorBatchFull: boolean } {
  const anchorBatchFull = anchors.length === limits.maxAnchors;
  if (!anchorBatchFull) return { until: bounds.maxAuditId, anchorLimited: false, anchorBatchFull };
  const highestTop = anchors.reduce(
    (max, a) => (a.top_audit_id > max ? a.top_audit_id : max),
    BigInt(0),
  );
  if (bounds.maxAuditId !== null && highestTop >= bounds.maxAuditId) {
    return { until: bounds.maxAuditId, anchorLimited: false, anchorBatchFull };
  }
  return { until: highestTop, anchorLimited: true, anchorBatchFull };
}

/** Anker in id-Reihenfolge, deren Spitze der Abschnitt abschließend gelesen hat. */
function dueAnchors(anchors: RollingAnchorMeta[], scope: SegmentScope): RollingAnchorMeta[] {
  if (scope.segmentEnd || scope.coveredUpTo === null) return anchors;
  const due: RollingAnchorMeta[] = [];
  for (const anchor of anchors) {
    if (anchor.top_audit_id > scope.coveredUpTo) break;
    due.push(anchor);
  }
  return due;
}

/**
 * Rekonstruierter Hash einer Siegel-/Ankerspitze: aus dem Walk des Abschnitts
 * oder, unterhalb des Prüfstands, per Einzel-Nachrechnung. undefined = fehlt;
 * 'broken' = gespeicherte Zeile reproduziert ihren Hash nicht (Bruch gesetzt).
 */
async function segmentHashAt(
  tx: Tx,
  tenantId: string,
  scope: SegmentScope,
  auditId: bigint,
  outcome: SegmentOutcome,
): Promise<Buffer | undefined | 'broken'> {
  if (auditId > scope.below) return scope.recomputed.get(auditId);
  const stored = await recomputeStoredRow(tx, tenantId, auditId);
  if (stored.kind === 'broken') {
    outcome.ok = false;
    outcome.firstBreak = stored.firstBreak;
    return 'broken';
  }
  return stored.kind === 'ok' ? stored.hash : undefined;
}

interface AuditChainRow {
  id: bigint;
  occurred_at: Date;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  prev_hash: Buffer;
  this_hash: Buffer;
}

const BATCH_SIZE = 1000;

interface SealRow {
  seal_date: Date;
  top_audit_id: bigint;
  top_hash: Buffer;
  tsa_response_blob: Buffer | null;
}

/** Begründungstexte der Siegelprüfung je Prüfkontext (R-15). */
interface SealBreakReasons {
  missing: (topAuditId: bigint) => string;
  topHashMismatch: string;
  tsaFailed: string;
}

const FULL_CHAIN_SEAL_REASONS: SealBreakReasons = {
  missing: (topAuditId) =>
    `versiegelter Spitzen-Eintrag (audit_id ${topAuditId}) fehlt in der rekonstruierten Kette`,
  topHashMismatch:
    'gespeicherter top_hash weicht vom rekonstruierten Ketten-Hash ab (DB-Manipulationsverdacht)',
  tsaFailed: 'TSA-Verifikation gegen rekonstruierten Ketten-Spitzen-Hash fehlgeschlagen',
};

const RECOVERY_SEAL_REASONS: SealBreakReasons = {
  missing: (topAuditId) =>
    `versiegelter Spitzen-Eintrag (audit_id ${topAuditId}) fehlt in der Recovery-Teilkette`,
  topHashMismatch: 'gespeicherter top_hash weicht vom rekonstruierten Recovery-Ketten-Hash ab',
  tsaFailed: 'TSA-Verifikation gegen Recovery-Ketten-Spitzen-Hash fehlgeschlagen',
};

/** Startpunkt eines Ketten-Walks (R-15). */
interface ChainWalkStart {
  /** Der Walk beginnt mit der ersten Zeile, deren ID größer ist. */
  afterAuditId: bigint;
  /** Erwarteter prev_hash dieser ersten Zeile (Genesis bzw. Vertrauensanker). */
  expectedPrev: Buffer;
}

interface ChainWalkOutcome {
  /** Lückenlos geprüfte Zeilen (vor einem etwaigen Bruch). */
  checked: number;
  /** Letzte intakt geprüfte Audit-ID; null, wenn keine Zeile geprüft wurde. */
  lastAuditId: bigint | null;
  /** Hash der letzten intakten Zeile (ohne geprüfte Zeile: expectedPrev). */
  lastHash: Buffer;
  /** true: keine weitere Zeile bis zur Obergrenze bzw. zum Kettenende. */
  exhausted: boolean;
  /** Erster Vorgänger- oder Hash-Bruch; beendet den Walk. */
  firstBreak?: NonNullable<VerificationResult['firstBreak']>;
}

/** Optionale Begrenzung eines Walks (P-04: fortsetzbare Abschnitte). */
interface ChainWalkLimits {
  /** Höchstens so viele Zeilen prüfen. */
  maxRows?: number;
  /** Nur Zeilen bis einschließlich dieser Audit-ID; null = bis zum Kettenende. */
  untilAuditId?: bigint | null;
}

/**
 * R-15: EIN SHA-256-Kettendurchlauf für verifyChain, verifyRecoverySegment und
 * die abschnittsweise Prüfung (verifyChainSegment).
 *
 * Liest die Kette cursor-basiert in BATCH_SIZE-Chunks strikt id-aufsteigend
 * (RF-5). Jede Zeile muss an den erwarteten Vorgänger binden und ihren
 * gespeicherten this_hash aus dem kanonischen Ereignis reproduzieren; der erste
 * Bruch beendet den Walk. `onRow` erhält für jede intakte Zeile den
 * REKONSTRUIERTEN Hash (Prüfwert für Siegel und Anker).
 */
async function walkChain(
  tx: Tx,
  tenantId: string,
  start: ChainWalkStart,
  onRow: (row: AuditChainRow, computed: Buffer) => void,
  limits: ChainWalkLimits = {},
): Promise<ChainWalkOutcome> {
  const outcome: ChainWalkOutcome = {
    checked: 0,
    lastAuditId: null,
    lastHash: start.expectedPrev,
    exhausted: false,
  };
  const maxRows = limits.maxRows ?? Number.POSITIVE_INFINITY;
  const until = limits.untilAuditId ?? null;
  let expectedPrev = start.expectedPrev;
  let cursor = start.afterAuditId;
  for (;;) {
    const want = Math.min(BATCH_SIZE, maxRows - outcome.checked);
    if (want <= 0) return outcome;
    const rows =
      until === null
        ? await fetchAuditBatch(tx, tenantId, cursor, want)
        : await fetchAuditBatchUntil(tx, tenantId, cursor, until, want);
    if (rows.length === 0) break;

    for (const r of rows) {
      // prev_hash muss mit erwartetem Vorgänger übereinstimmen
      if (!Buffer.from(r.prev_hash).equals(expectedPrev)) {
        outcome.firstBreak = chainBreak(r, expectedPrev, r.prev_hash);
        return outcome;
      }

      const computed = eventHash(expectedPrev, chainEventOf(tenantId, r));
      if (!computed.equals(Buffer.from(r.this_hash))) {
        outcome.firstBreak = chainBreak(r, computed, r.this_hash);
        return outcome;
      }

      onRow(r, computed);
      expectedPrev = Buffer.from(r.this_hash);
      outcome.checked++;
      outcome.lastAuditId = r.id;
      outcome.lastHash = computed;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < want) break;
  }
  outcome.exhausted = true;
  return outcome;
}

/** Kanonisches Ereignis einer gespeicherten Zeile (dieselbe Abbildung wie record()). */
function chainEventOf(tenantId: string, r: AuditChainRow): ChainEvent {
  return {
    tenantId,
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    before: r.before,
    after: r.after,
  };
}

function chainBreak(
  r: Pick<AuditChainRow, 'id' | 'occurred_at'>,
  expected: Buffer,
  actual: Uint8Array,
): NonNullable<VerificationResult['firstBreak']> {
  return {
    auditId: r.id,
    occurredAt: r.occurred_at,
    expectedHash: expected.toString('hex'),
    actualHash: Buffer.from(actual).toString('hex'),
  };
}

/** Zähler und Brüche der Siegelprüfung (VerificationResult oder Abschnitt). */
type SealTally = Pick<
  VerificationResult,
  'ok' | 'sealsChecked' | 'sealsTrustAnchored' | 'sealBreaks'
>;

/** Zähler und Brüche der Ankerprüfung (VerificationResult oder Abschnitt). */
type AnchorTally = Pick<
  VerificationResult,
  'ok' | 'anchorsChecked' | 'anchorsTrustAnchored' | 'anchorBreaks'
>;

/** Erwarteter Vorgänger des nächsten Rolling-Ankers. */
interface AnchorChainState {
  expectedPreviousAnchorHash: Buffer;
  previousTopAuditId: bigint;
}

/** TSA-Antworten je Abfrage (P-04: keine Abfrage über alle Anker-Blobs). */
const ANCHOR_BATCH_SIZE = 200;

/** Lädt die TSA-Antworten eines id-aufsteigenden Ankerblocks. */
async function fetchAnchorBlobs(
  tx: Tx,
  tenantId: string,
  batch: RollingAnchorMeta[],
): Promise<Map<bigint, Buffer>> {
  const blobs = new Map<bigint, Buffer>();
  if (batch.length === 0) return blobs;
  const rows = await tx.$queryRaw<Array<{ id: bigint; tsa_response_blob: Buffer }>>`
    SELECT id, tsa_response_blob
    FROM audit_anchor
    WHERE tenant_id = ${tenantId}::uuid
      AND id >= ${batch[0]!.id}
      AND id <= ${batch[batch.length - 1]!.id}
    ORDER BY id ASC
  `;
  for (const row of rows) blobs.set(row.id, Buffer.from(row.tsa_response_blob));
  return blobs;
}

/** P-04: nächster Block Anker-Metadaten nach `afterId` bis einschließlich `maxId`. */
async function fetchAnchorMetaAfter(
  tx: Tx,
  tenantId: string,
  afterId: bigint,
  maxId: bigint,
  limit: number,
): Promise<RollingAnchorMeta[]> {
  return tx.$queryRaw<RollingAnchorMeta[]>`
    SELECT id, from_audit_id, top_audit_id, top_hash,
           previous_anchor_hash, anchor_hash
    FROM audit_anchor
    WHERE tenant_id = ${tenantId}::uuid
      AND id > ${afterId}
      AND id <= ${maxId}
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}

/**
 * P-04: Siegel eines Prüfabschnitts. Spitze im gelesenen Bereich (below, upTo]
 * (upTo null = ohne Obergrenze; Spitzen jenseits des Kettenendes fehlen) oder
 * nachträglich angelegt (id > sealIdAfter) mit Spitze ≤ below — jeweils nur bis
 * zur vorab ermittelten Siegelgrenze maxSealId.
 */
async function fetchSegmentSeals(
  tx: Tx,
  tenantId: string,
  range: { below: bigint; upTo: bigint | null; sealIdAfter: bigint; maxSealId: bigint },
): Promise<Array<SealRow & { id: bigint }>> {
  return tx.$queryRaw<Array<SealRow & { id: bigint }>>`
    SELECT id, seal_date, top_audit_id, top_hash, tsa_response_blob
    FROM audit_seal
    WHERE tenant_id = ${tenantId}::uuid
      AND id <= ${range.maxSealId}
      AND (
        (top_audit_id > ${range.below}
          AND (${range.upTo}::bigint IS NULL OR top_audit_id <= ${range.upTo}::bigint))
        OR (top_audit_id <= ${range.below} AND id > ${range.sealIdAfter})
      )
    ORDER BY seal_date ASC, id ASC
  `;
}

/**
 * Ergänzt die TSA-Antwort. Fehlt sie (Zeile zwischen den Abfragen entfernt),
 * scheitert die anchor_hash-Prüfung an der leeren Antwort statt still zu passen.
 */
function withBlob(anchor: RollingAnchorMeta, blobs: Map<bigint, Buffer>): RollingAnchorRow {
  return { ...anchor, tsa_response_blob: blobs.get(anchor.id) ?? Buffer.alloc(0) };
}

function initializeAnchorSummary(
  result: VerificationResult,
  anchors: RollingAnchorMeta[],
): bigint | null {
  const latest = anchors.at(-1);
  result.lastAnchorId = latest?.id ?? null;
  result.lastAnchoredAuditId = latest?.top_audit_id ?? null;
  return result.lastAnchoredAuditId;
}

function trackAuditCheckpoint(
  result: VerificationResult,
  recomputedTops: Map<bigint, Buffer>,
  sealTopIds: Set<bigint>,
  anchorTopIds: Set<bigint>,
  lastAnchoredAuditId: bigint | null,
  row: Pick<AuditChainRow, 'id' | 'occurred_at'>,
  computed: Buffer,
): void {
  if (sealTopIds.has(row.id) || anchorTopIds.has(row.id)) {
    recomputedTops.set(row.id, computed);
  }
  if (lastAnchoredAuditId === null || row.id > lastAnchoredAuditId) {
    result.unanchoredEntries++;
    result.oldestUnanchoredAt ??= row.occurred_at;
  }
}

function anchorStructureError(
  anchor: RollingAnchorMeta,
  previousTopAuditId: bigint,
  expectedPreviousAnchorHash: Buffer,
): string | null {
  if (anchor.from_audit_id > anchor.top_audit_id || anchor.from_audit_id <= previousTopAuditId) {
    return 'ungültiger oder überlappender Audit-ID-Bereich im Rolling-Anchor';
  }
  if (!Buffer.from(anchor.previous_anchor_hash).equals(expectedPreviousAnchorHash)) {
    return 'previous_anchor_hash passt nicht zur externen Vorgängerkette';
  }
  return null;
}

function anchorLocalTipError(
  anchor: RollingAnchorMeta,
  recomputed: Buffer | undefined,
): string | null {
  if (!recomputed) return `verankerter Spitzen-Eintrag audit_id ${anchor.top_audit_id} fehlt`;
  if (!recomputed.equals(Buffer.from(anchor.top_hash))) {
    return 'top_hash weicht vom rekonstruierten lokalen Ketten-Hash ab';
  }
  return null;
}

function addAnchorBreak(result: AnchorTally, anchor: RollingAnchorMeta, reason: string): void {
  result.ok = false;
  result.anchorBreaks.push({
    anchorId: anchor.id,
    topAuditId: anchor.top_audit_id,
    reason,
  });
}

export function applyUnanchoredAgePolicy(
  result: VerificationResult,
  maxUnanchoredAgeMs: number | undefined,
): void {
  if (maxUnanchoredAgeMs === undefined || !result.oldestUnanchoredAt) return;
  if (Date.now() - result.oldestUnanchoredAt.getTime() <= maxUnanchoredAgeMs) return;
  result.ok = false;
  result.policyBreaks.push(
    `${result.unanchoredEntries} Audit-Eintrag/-Einträge länger als ` +
      `${Math.ceil(maxUnanchoredAgeMs / 1000)} Sekunden ohne externen RFC-3161-Anker.`,
  );
}

/** RF-5: ein id-aufsteigender Chunk der Audit-Chain (Cursor = letzte id). */
async function fetchAuditBatch(
  tx: Tx,
  tenantId: string,
  cursor: bigint,
  limit: number,
): Promise<AuditChainRow[]> {
  return tx.$queryRaw<AuditChainRow[]>`
    SELECT id, occurred_at, actor_type, actor_id, action,
           resource_type, resource_id, "before", "after",
           prev_hash, this_hash
    FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid
      AND id > ${cursor}
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}

/** P-04: wie fetchAuditBatch, aber nur bis zur inklusiven Obergrenze `until`. */
async function fetchAuditBatchUntil(
  tx: Tx,
  tenantId: string,
  cursor: bigint,
  until: bigint,
  limit: number,
): Promise<AuditChainRow[]> {
  return tx.$queryRaw<AuditChainRow[]>`
    SELECT id, occurred_at, actor_type, actor_id, action,
           resource_type, resource_id, "before", "after",
           prev_hash, this_hash
    FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid
      AND id > ${cursor}
      AND id <= ${until}
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}

/** Ergebnis der Einzel-Nachrechnung einer gespeicherten Zeile. */
export type StoredRowCheck =
  | { kind: 'ok'; hash: Buffer }
  | { kind: 'missing' }
  | { kind: 'broken'; firstBreak: NonNullable<VerificationResult['firstBreak']> };

/**
 * P-04: rechnet EINE gespeicherte Zeile aus ihrem Inhalt und ihrem gespeicherten
 * prev_hash nach. Dient für Kettenpositionen unterhalb eines Prüf-Checkpoints,
 * die ein früherer Walk bereits lückenlos verknüpft hat (Checkpoint-Zeile,
 * nachträglich angelegte Siegel/Anker). Die Verknüpfung zum Vorgänger bestätigt
 * erst wieder die periodische Vollprüfung.
 */
export async function recomputeStoredRow(
  tx: Tx,
  tenantId: string,
  auditId: bigint,
): Promise<StoredRowCheck> {
  const rows = await tx.$queryRaw<AuditChainRow[]>`
    SELECT id, occurred_at, actor_type, actor_id, action,
           resource_type, resource_id, "before", "after",
           prev_hash, this_hash
    FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid
      AND id = ${auditId}
  `;
  const row = rows[0];
  if (!row) return { kind: 'missing' };
  const computed = eventHash(Buffer.from(row.prev_hash), chainEventOf(tenantId, row));
  if (!computed.equals(Buffer.from(row.this_hash))) {
    return { kind: 'broken', firstBreak: chainBreak(row, computed, row.this_hash) };
  }
  return { kind: 'ok', hash: computed };
}

export function genesisHash(tenantId: string): Buffer {
  return createHash('sha256').update(GENESIS_PREFIX).update(Buffer.from(tenantId, 'utf8')).digest();
}

function dateOnly(d: Date): string {
  // YYYY-MM-DD in UTC für Date-Spalten.
  return d.toISOString().slice(0, 10);
}

/** P-05: Antwort, wenn ein paralleler Lauf den Lease dieses Tenants hält. */
export const ANCHOR_LOCKED_REASON =
  'Rolling-Anchor dieses Tenants läuft bereits in einem anderen Lauf';

/** P-05: Lease vor der TSA-Anfrage nicht mehr gültig (abgelaufen/übernommen). */
export const ANCHOR_LEASE_LOST_REASON =
  'Rolling-Anchor-Lease dieses Tenants ist nicht mehr gültig; keine TSA-Anfrage';

/** P-05: Lease während der TSA-Anfrage abgelaufen oder übernommen. */
export const ANCHOR_LEASE_EXPIRED_REASON =
  'Rolling-Anchor-Lease dieses Tenants ist während der TSA-Anfrage abgelaufen; Token verworfen';

function computeLockKey(tenantId: string): bigint {
  // 64-Bit-Lock-Key aus den ersten 8 Bytes des SHA-256 von "audit-chain:<tenantId>".
  // Determ., kollisionsarm, und passt in Postgres' bigint.
  const hash = createHash('sha256').update(`audit-chain:${tenantId}`).digest();
  return hash.readBigInt64BE(0);
}
