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
// =============================================================================

import { createHash } from 'node:crypto';
import type { PrismaClient, AuditActorType } from '@prisma/client';
import { eventHash, chainValue } from './chain';
import { anchorGenesisHash, anchorPayload, anchorTokenHash } from './anchor';
import type { TimestampPort } from './ports/timestamp';

type Tx = Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe' | '$executeRaw'>;

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

interface RollingAnchorRow {
  id: bigint;
  from_audit_id: bigint;
  top_audit_id: bigint;
  top_hash: Buffer;
  previous_anchor_hash: Buffer;
  anchor_hash: Buffer;
  tsa_response_blob: Buffer;
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
    const stamp = await this.timestampPort.timestamp(payload);
    if (!stamp.tsaRequestBlob || !stamp.tsaResponseBlob) {
      throw new Error('RFC-3161-TSA lieferte keinen vollständigen Request-/Response-Nachweis.');
    }

    const response = Buffer.from(stamp.tsaResponseBlob);
    let verified: { ok: boolean; trustAnchored: boolean };
    if (this.timestampPort.verifyDetailed) {
      verified = await this.timestampPort.verifyDetailed(payload, response);
    } else {
      verified = {
        ok: await this.timestampPort.verify(payload, response),
        trustAnchored: false,
      };
    }
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
        ${Buffer.from(stamp.tsaRequestBlob)},
        ${response},
        ${stamp.tsaSerial},
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
      tsaMode: this.timestampPort.mode,
      policyBreaks: [],
    };

    // Policy: Self-Timestamp im Produktivmodus ist kein Drittnachweis → harter Fail.
    // (Der Modus wird oben unabhängig davon IMMER im Report ausgewiesen.)
    if (opts.requireExternalTsa && this.timestampPort.mode === 'local') {
      result.ok = false;
      result.policyBreaks.push(
        'Self-Timestamp (LocalTimestampAdapter) im Produktivmodus unzulässig — ' +
          'externe RFC-3161-TSA erforderlich (TIMESTAMP_AUTHORITY_URL setzen).',
      );
    }

    // Seals VORAB laden — ihre top_audit_id steuert, welchen rekonstruierten
    // Ketten-Hash wir während des Walks festhalten müssen (Punkt 2: der TSA-
    // Imprint wird gegen DIESEN Wert geprüft, nie gegen die gespeicherte Spalte).
    const seals = await tx.$queryRaw<
      Array<{
        seal_date: Date;
        top_audit_id: bigint;
        top_hash: Buffer;
        tsa_response_blob: Buffer | null;
      }>
    >`
      SELECT seal_date, top_audit_id, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY seal_date ASC
    `;
    const sealTopIds = new Set<bigint>(seals.map((s) => s.top_audit_id));
    const anchors = await tx.$queryRaw<RollingAnchorRow[]>`
      SELECT id, from_audit_id, top_audit_id, top_hash,
             previous_anchor_hash, anchor_hash, tsa_response_blob
      FROM audit_anchor
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id ASC
    `;
    const anchorTopIds = new Set<bigint>(anchors.map((a) => a.top_audit_id));
    const lastAnchoredAuditId = initializeAnchorSummary(result, anchors);
    const recomputedTops = new Map<bigint, Buffer>();

    // 1. Audit-Chain durchgehen. RF-5: cursor-basiert in 1000er-Chunks nach id
    //    statt alle Rows auf einmal — der Speicherbedarf wächst sonst linear
    //    mit der audit_log-Größe. Semantik identisch: der Walk läuft weiterhin
    //    strikt id-aufsteigend über ALLE Zeilen des Tenants.
    let expectedPrev = genesisHash(tenantId);
    let cursor = BigInt(-1);
    for (;;) {
      const rows = await fetchAuditBatch(tx, tenantId, cursor, BATCH_SIZE);
      if (rows.length === 0) break;

      for (const r of rows) {
        // prev_hash muss mit erwartetem Vorgänger übereinstimmen
        if (!Buffer.from(r.prev_hash).equals(expectedPrev)) {
          result.ok = false;
          result.firstBreak = {
            auditId: r.id,
            occurredAt: r.occurred_at,
            expectedHash: expectedPrev.toString('hex'),
            actualHash: Buffer.from(r.prev_hash).toString('hex'),
          };
          return result;
        }

        const computed = eventHash(expectedPrev, {
          tenantId,
          occurredAt: r.occurred_at,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          before: r.before,
          after: r.after,
        });

        if (!computed.equals(Buffer.from(r.this_hash))) {
          result.ok = false;
          result.firstBreak = {
            auditId: r.id,
            occurredAt: r.occurred_at,
            expectedHash: computed.toString('hex'),
            actualHash: Buffer.from(r.this_hash).toString('hex'),
          };
          return result;
        }

        // Den AUS DER KETTE REKONSTRUIERTEN Spitzen-Hash dieses Eintrags festhalten,
        // falls er versiegelt wurde — er (nicht die DB-Spalte) ist der Prüfwert unten.
        trackAuditCheckpoint(
          result,
          recomputedTops,
          sealTopIds,
          anchorTopIds,
          lastAnchoredAuditId,
          r,
          computed,
        );

        expectedPrev = Buffer.from(r.this_hash);
        result.checked++;
        result.lastAuditId = r.id;
      }

      cursor = rows[rows.length - 1]!.id;
      if (rows.length < BATCH_SIZE) break;
    }

    // 2. Tages-Stempel verifizieren — gegen den REKONSTRUIERTEN Ketten-Hash.
    //    NIE gegen audit_seal.top_hash (gespeicherte Spalte): das wäre DB-gegen-DB
    //    und ließe einen Angreifer, der die History konsistent umschreibt, passieren.
    //    Der Prüfwert kommt ausschließlich aus dem SHA-256-Walk oben.
    for (const s of seals) {
      result.sealsChecked++;
      const recomputed = recomputedTops.get(s.top_audit_id);
      if (!recomputed) {
        // Der versiegelte Spitzen-Eintrag existiert nicht mehr in der rekonstruierten
        // Kette (gelöscht/abgeschnitten) — der Stempel hängt in der Luft.
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: `versiegelter Spitzen-Eintrag (audit_id ${s.top_audit_id}) fehlt in der rekonstruierten Kette`,
        });
        continue;
      }
      // Spalten-Integrität: gespeicherter top_hash MUSS dem rekonstruierten Hash
      // entsprechen. Fängt DB-Manipulation auch dann, wenn ein lokaler Adapter
      // keinen kryptografischen verify() leistet (verify() gibt dort immer true).
      if (!recomputed.equals(Buffer.from(s.top_hash))) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason:
            'gespeicherter top_hash weicht vom rekonstruierten Ketten-Hash ab (DB-Manipulationsverdacht)',
        });
        continue;
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
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'TSA-Verifikation gegen rekonstruierten Ketten-Spitzen-Hash fehlgeschlagen',
        });
      }
    }

    await this.verifyRollingAnchors(tenantId, anchors, recomputedTops, result);
    applyUnanchoredAgePolicy(result, opts.maxUnanchoredAgeMs);

    return result;
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

  /** Verifies the sparse external chain against reconstructed local tips. */
  private async verifyRollingAnchors(
    tenantId: string,
    anchors: RollingAnchorRow[],
    recomputedTops: Map<bigint, Buffer>,
    result: VerificationResult,
  ): Promise<void> {
    let expectedPreviousAnchorHash = anchorGenesisHash(tenantId);
    let previousTopAuditId = BigInt(0);
    for (const anchor of anchors) {
      result.anchorsChecked++;
      const structuralError = anchorStructureError(
        anchor,
        previousTopAuditId,
        expectedPreviousAnchorHash,
      );
      if (structuralError) {
        addAnchorBreak(result, anchor, structuralError);
        continue;
      }

      const recomputed = recomputedTops.get(anchor.top_audit_id);
      const localTipError = anchorLocalTipError(anchor, recomputed);
      if (localTipError || !recomputed) {
        addAnchorBreak(result, anchor, localTipError ?? 'verankerter Spitzen-Eintrag fehlt');
        continue;
      }

      const response = Buffer.from(anchor.tsa_response_blob);
      const computedAnchorHash = anchorTokenHash(response);
      if (!computedAnchorHash.equals(Buffer.from(anchor.anchor_hash))) {
        addAnchorBreak(
          result,
          anchor,
          'anchor_hash stimmt nicht mit dem gespeicherten TSA-Token überein',
        );
        continue;
      }
      const payload = anchorPayload({
        tenantId,
        fromAuditId: anchor.from_audit_id,
        topAuditId: anchor.top_audit_id,
        topHash: recomputed,
        previousAnchorHash: expectedPreviousAnchorHash,
      });
      const verification = await this.verifySealBinding(payload, response);
      if (!verification.ok) {
        addAnchorBreak(result, anchor, 'RFC-3161-Verifikation des Rolling-Ankers fehlgeschlagen');
        continue;
      }
      if (verification.trustAnchored) result.anchorsTrustAnchored++;

      expectedPreviousAnchorHash = computedAnchorHash;
      previousTopAuditId = anchor.top_audit_id;
    }
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
      tsaMode: this.timestampPort.mode,
      policyBreaks: [],
    };

    if (opts.requireExternalTsa && this.timestampPort.mode === 'local') {
      result.ok = false;
      result.policyBreaks.push(
        'Self-Timestamp (LocalTimestampAdapter) im Produktivmodus unzulässig — ' +
          'externe RFC-3161-TSA erforderlich (TIMESTAMP_AUTHORITY_URL setzen).',
      );
    }

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

    const seals = await tx.$queryRaw<
      Array<{
        seal_date: Date;
        top_audit_id: bigint;
        top_hash: Buffer;
        tsa_response_blob: Buffer | null;
      }>
    >`
      SELECT seal_date, top_audit_id, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
        AND top_audit_id >= ${checkpointAuditId}
      ORDER BY seal_date ASC
    `;
    const sealTopIds = new Set<bigint>(seals.map((s) => s.top_audit_id));
    const recomputedTops = new Map<bigint, Buffer>();

    const startCursor = checkpointAuditId - BigInt(1);
    let expectedPrev = Buffer.from(anchor[0]!.prev_hash);
    let cursor = startCursor;
    for (;;) {
      const rows = await fetchAuditBatch(tx, tenantId, cursor, BATCH_SIZE);
      if (rows.length === 0) break;

      for (const r of rows) {
        if (!Buffer.from(r.prev_hash).equals(expectedPrev)) {
          result.ok = false;
          result.firstBreak = {
            auditId: r.id,
            occurredAt: r.occurred_at,
            expectedHash: expectedPrev.toString('hex'),
            actualHash: Buffer.from(r.prev_hash).toString('hex'),
          };
          return result;
        }

        const computed = eventHash(expectedPrev, {
          tenantId,
          occurredAt: r.occurred_at,
          actorType: r.actor_type,
          actorId: r.actor_id,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          before: r.before,
          after: r.after,
        });

        if (!computed.equals(Buffer.from(r.this_hash))) {
          result.ok = false;
          result.firstBreak = {
            auditId: r.id,
            occurredAt: r.occurred_at,
            expectedHash: computed.toString('hex'),
            actualHash: Buffer.from(r.this_hash).toString('hex'),
          };
          return result;
        }

        if (sealTopIds.has(r.id)) recomputedTops.set(r.id, computed);

        expectedPrev = Buffer.from(r.this_hash);
        result.checked++;
        result.lastAuditId = r.id;
      }

      cursor = rows[rows.length - 1]!.id;
      if (rows.length < BATCH_SIZE) break;
    }

    for (const s of seals) {
      result.sealsChecked++;
      const recomputed = recomputedTops.get(s.top_audit_id);
      if (!recomputed) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: `versiegelter Spitzen-Eintrag (audit_id ${s.top_audit_id}) fehlt in der Recovery-Teilkette`,
        });
        continue;
      }
      if (!recomputed.equals(Buffer.from(s.top_hash))) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'gespeicherter top_hash weicht vom rekonstruierten Recovery-Ketten-Hash ab',
        });
        continue;
      }
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
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'TSA-Verifikation gegen Recovery-Ketten-Spitzen-Hash fehlgeschlagen',
        });
      }
    }

    return result;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

function initializeAnchorSummary(
  result: VerificationResult,
  anchors: RollingAnchorRow[],
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
  anchor: RollingAnchorRow,
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
  anchor: RollingAnchorRow,
  recomputed: Buffer | undefined,
): string | null {
  if (!recomputed) return `verankerter Spitzen-Eintrag audit_id ${anchor.top_audit_id} fehlt`;
  if (!recomputed.equals(Buffer.from(anchor.top_hash))) {
    return 'top_hash weicht vom rekonstruierten lokalen Ketten-Hash ab';
  }
  return null;
}

function addAnchorBreak(
  result: VerificationResult,
  anchor: RollingAnchorRow,
  reason: string,
): void {
  result.ok = false;
  result.anchorBreaks.push({
    anchorId: anchor.id,
    topAuditId: anchor.top_audit_id,
    reason,
  });
}

function applyUnanchoredAgePolicy(
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

function genesisHash(tenantId: string): Buffer {
  return createHash('sha256').update(GENESIS_PREFIX).update(Buffer.from(tenantId, 'utf8')).digest();
}

function dateOnly(d: Date): string {
  // YYYY-MM-DD in UTC für Date-Spalten.
  return d.toISOString().slice(0, 10);
}

function computeLockKey(tenantId: string): bigint {
  // 64-Bit-Lock-Key aus den ersten 8 Bytes des SHA-256 von "audit-chain:<tenantId>".
  // Determ., kollisionsarm, und passt in Postgres' bigint.
  const hash = createHash('sha256').update(`audit-chain:${tenantId}`).digest();
  return hash.readBigInt64BE(0);
}
