// Fachkatalog: AUDIT-HASH-CHAIN-001, AUDIT-VERIFY-ALERT-001, AUDIT-RFC3161-ANCHOR-001
// =============================================================================
// P-04: checkpointgestützte Kettenprüfung gegen echtes PostgreSQL.
//
// Belegt: (1) gleiches Ergebnis wie die checkpointfreie Vollprüfung verifyChain,
// (2) Folgeläufe hashen nur den Zuwachs, (3) nachträglich angelegte Siegel und
// Anker unterhalb des Checkpoints werden geprüft, (4) ein manipulierter
// Checkpoint oder eine manipulierte Checkpoint-Zeile fällt sofort auf,
// (5) Manipulation unterhalb des Checkpoints findet die (fortsetzbare)
// Vollprüfung, (6) Anker werden blockweise geladen, (7) B15: zwischen zwei
// Läufen wieder eingespielte ältere Stände fallen am Fortschrittsanker des
// vorigen Prüfergebnisses auf.
//
// Alle Audit-, Siegel-, Anker- und Checkpoint-Zeilen entstehen in einer
// Owner-Transaktion, die am Testende zurückgerollt wird; Manipulationen
// schalten den Schutz-Trigger nur innerhalb dieser Transaktion ab.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { Prisma } from '@prisma/client';
import { EvidenceService, genesisCursor, type VerificationResult } from '../service';
import {
  MAX_STORED_FINDINGS,
  checkpointMac,
  loadVerifyCheckpoint,
  progressAnchorMac,
  verifyChainWithCheckpoints,
  type CheckpointedVerifyOptions,
  type StoredVerifyCheckpoint,
  type VerifyCheckpointKind,
} from '../verify-checkpoint';
import {
  LocalTimestampAdapter,
  type TimestampPort,
  type TimestampResult,
} from '../ports/timestamp';

// Der Quality-Job hat Platzhalter-URLs, aber keine Datenbank. Der db-Job
// schaltet die Suite ausdrücklich ein; ungültige Ziele scheitern dann sofort.
// S-01: Dort ist DATABASE_URL die Owner-Rolle der Container (taxtronik_owner),
// der keine Tabelle gehört. Die Manipulations-Fixtures schalten Schutz-Trigger
// ab und laufen deshalb über EVIDENCE_DB_ADMIN_URL (Tabellen-Owner).
// B-02: lokal per EVIDENCE_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['EVIDENCE_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'EVIDENCE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'EVIDENCE_DB_ADMIN_URL']) {
    if (name === 'EVIDENCE_DB_ADMIN_URL' && !process.env[name]) continue;
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`EVIDENCE_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`EVIDENCE_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

/** Rolle aus DATABASE_URL, wenn die Fixture-Sitzung eine andere Rolle ist. */
function serviceRoleBehindAdmin(): string | null {
  const admin = process.env['EVIDENCE_DB_ADMIN_URL'];
  const service = process.env['DATABASE_URL'];
  if (!admin || !service) return null;
  const serviceUser = decodeURIComponent(new URL(service).username);
  return serviceUser !== decodeURIComponent(new URL(admin).username) ? serviceUser : null;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sha256(b: Uint8Array | string): Buffer {
  return createHash('sha256').update(b).digest();
}

/** Externe TSA-Attrappe: Token = sha256(Payload), trust-verankert. */
class StubTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  async timestamp(payload: Uint8Array): Promise<TimestampResult> {
    return {
      timestampedAt: new Date().toISOString(),
      tsaRequestBlob: Buffer.from('request'),
      tsaResponseBlob: sha256(payload),
      tsaSerial: '1',
    };
  }
  async verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean> {
    return !!response && sha256(payload).equals(Buffer.from(response));
  }
  async verifyDetailed(payload: Uint8Array, response: Uint8Array | null) {
    const ok = await this.verify(payload, response);
    return { ok, trustAnchored: ok };
  }
}

/** Owner-Transaktion (inkl. $executeRawUnsafe für die Manipulationen). */
type EvidenceTx = Prisma.TransactionClient;

const ROLLBACK = new Error('rollback');
const SMALL = { maxRows: 7, maxAnchors: 2 };
/** HMAC-Schlüssel der Checkpoints (Worker: HKDF aus dem Worker-Geheimnis). */
const KEY = Buffer.alloc(32, 7);
const DAY = 24 * 60 * 60 * 1000;

(enabled ? describe : describe.skip)('P-04: checkpointgestützte Kettenprüfung (PostgreSQL)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  // Szenarien laufen in einer Sitzung, die Schutz-Trigger abschalten darf.
  // Ist das eine andere Rolle als DATABASE_URL, gilt für alles außer tamper()
  // per SET LOCAL ROLE die Owner-Rolle der Container.
  const serviceRole = serviceRoleBehindAdmin();
  const admin = serviceRole
    ? new PrismaClient({
        adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['EVIDENCE_DB_ADMIN_URL'])),
      })
    : owner;
  const service = new EvidenceService(new StubTsa());
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (
      await owner.tenant.create({
        data: { slug: `verify-checkpoint-${randomUUID()}`, name: 'Prüf-Checkpoint-Test' },
      })
    ).id;
  });

  afterAll(async () => {
    // Alle Audit-/Checkpoint-Zeilen wurden zurückgerollt; der Tenant ist leer.
    await owner.tenant.delete({ where: { id: tenantId } });
    await owner.$disconnect();
    if (admin !== owner) await admin.$disconnect();
  });

  /** Führt das Szenario in einer Owner-Transaktion aus und rollt sie zurück. */
  async function inRollback(scenario: (tx: EvidenceTx) => Promise<void>): Promise<void> {
    await expect(
      admin.$transaction(
        async (tx) => {
          if (serviceRole) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quoteIdent(serviceRole)}`);
          await scenario(tx);
          throw ROLLBACK;
        },
        { timeout: 120_000, maxWait: 10_000 },
      ),
    ).rejects.toBe(ROLLBACK);
  }

  async function record(tx: EvidenceTx, count: number, action = 'test.checkpoint') {
    for (let i = 0; i < count; i++) {
      await service.record(tx, {
        tenantId,
        actorType: 'SYSTEM',
        actorId: null,
        action,
        resourceType: 'test',
        resourceId: randomUUID(),
        after: { i, nested: { at: new Date().toISOString() } },
      });
    }
  }

  /** Legt Einträge mit vorgegebenem Ereigniszeitpunkt an (für Tagessiegel). */
  async function recordAt(tx: EvidenceTx, at: Date, count: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at);
      await record(tx, count);
    } finally {
      vi.useRealTimers();
    }
  }

  function options(overrides: Partial<CheckpointedVerifyOptions> = {}) {
    return {
      checkpointKey: KEY,
      fullVerifyIntervalMs: 7 * DAY,
      fullVerifyBudgetMs: 60_000,
      segmentLimits: SMALL,
      ...overrides,
    } satisfies CheckpointedVerifyOptions;
  }

  function run(tx: EvidenceTx, overrides: Partial<CheckpointedVerifyOptions> = {}) {
    return verifyChainWithCheckpoints(service, (work) => work(tx), tenantId, options(overrides));
  }

  /** Alle Felder außer dem Prüfumfang müssen exakt verifyChain entsprechen. */
  async function expectSameAsVerifyChain(tx: EvidenceTx, result: VerificationResult) {
    const reference = await service.verifyChain(tx, tenantId);
    const { incremental: _scope, ...comparable } = result;
    expect(comparable).toEqual(reference);
    return reference;
  }

  /** Authentischer Checkpoint oder null; ein ungültiger lässt den Test scheitern. */
  async function stored(
    tx: EvidenceTx,
    kind: VerifyCheckpointKind = 'INCREMENTAL',
    now = new Date(Date.now() + 9 * DAY),
  ): Promise<StoredVerifyCheckpoint | null> {
    const loaded = await loadVerifyCheckpoint(tx, KEY, tenantId, kind, now);
    if (loaded.status === 'invalid') throw new Error(loaded.problem);
    return loaded.status === 'ok' ? loaded.checkpoint : null;
  }

  /** Schreibt einen Checkpoint mit gültiger Prüfsumme (Angreifer MIT Schlüssel). */
  async function forge(tx: EvidenceTx, changed: StoredVerifyCheckpoint) {
    const mac = checkpointMac(KEY, tenantId, changed);
    await tx.$executeRaw`
      UPDATE audit_verify_checkpoint
      SET audit_count = ${changed.cursor.auditCount},
          audit_hash = ${changed.cursor.auditHash},
          completed_at = ${changed.completedAt},
          verified_at = ${changed.verifiedAt},
          mac = ${mac}
      WHERE tenant_id = ${tenantId}::uuid AND kind = ${changed.kind}
    `;
  }

  async function tamper(tx: EvidenceTx, table: string, trigger: string, sql: string) {
    if (serviceRole) await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await tx.$executeRawUnsafe(sql);
    await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    if (serviceRole) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${quoteIdent(serviceRole)}`);
  }

  async function lastAuditId(tx: EvidenceTx): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT max(id) AS id FROM audit_log WHERE tenant_id = ${tenantId}::uuid
    `;
    return rows[0]!.id;
  }

  async function nthAuditId(tx: EvidenceTx, n: number): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM audit_log WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id ASC OFFSET ${n} LIMIT 1
    `;
    return rows[0]!.id;
  }

  /** Ungültiges Tagessiegel auf einer Zeile (wie ein Insert der App-Rolle). */
  async function insertBogusSeal(tx: EvidenceTx, top: bigint, date: string, id?: bigint) {
    if (id === undefined) {
      await tx.$executeRaw`
        INSERT INTO audit_seal (tenant_id, seal_date, top_audit_id, top_hash,
                                tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at)
        SELECT ${tenantId}::uuid, ${date}::date, id, this_hash,
               NULL, ${sha256(`fremd-${date}`)}, 'x', now()
        FROM audit_log WHERE id = ${top}
      `;
      return;
    }
    await tx.$executeRaw`
      INSERT INTO audit_seal (id, tenant_id, seal_date, top_audit_id, top_hash,
                              tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at)
      SELECT ${id}, ${tenantId}::uuid, ${date}::date, id, this_hash,
             NULL, ${sha256(`fremd-${date}`)}, 'x', now()
      FROM audit_log WHERE id = ${top}
    `;
  }

  /** Strukturell verketteter Rolling-Anker mit ungültigem Token an der Spitze. */
  async function insertBogusAnchor(tx: EvidenceTx) {
    await tx.$executeRaw`
      INSERT INTO audit_anchor (
        tenant_id, from_audit_id, top_audit_id, top_hash, previous_anchor_hash, anchor_hash,
        tsa_request_blob, tsa_response_blob, tsa_serial, tsa_gen_time, trust_anchored
      )
      SELECT ${tenantId}::uuid, prev.top_audit_id + 1, tip.id, tip.this_hash, prev.anchor_hash,
             ${sha256(`fremder-anker-${randomUUID()}`)}, '\\x00', '\\x01', 'x', now(), true
      FROM (SELECT top_audit_id, anchor_hash FROM audit_anchor
             WHERE tenant_id = ${tenantId}::uuid ORDER BY id DESC LIMIT 1) prev,
           (SELECT id, this_hash FROM audit_log
             WHERE tenant_id = ${tenantId}::uuid ORDER BY id DESC LIMIT 1) tip
    `;
  }

  /** n ungültige Tagessiegel auf derselben Zeile, aufsteigende Daten ab `from`. */
  async function insertBogusSeals(tx: EvidenceTx, top: bigint, from: string, n: number) {
    await tx.$executeRaw`
      INSERT INTO audit_seal (tenant_id, seal_date, top_audit_id, top_hash,
                              tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at)
      SELECT ${tenantId}::uuid, ${from}::date + g, a.id, a.this_hash,
             NULL, ${sha256('fremde-serie')}, 'x', now()
      FROM audit_log a, generate_series(0, ${n - 1}) AS g
      WHERE a.id = ${top}
      ORDER BY g
    `;
  }

  /** Checkpoint-Zeilen als JSON festhalten (Angreifer ohne Schlüssel). */
  async function captureRows(tx: EvidenceTx, kinds: VerifyCheckpointKind[]): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ rows: unknown }>>`
      SELECT COALESCE(jsonb_agg(to_jsonb(c)), '[]'::jsonb) AS rows
      FROM audit_verify_checkpoint c
      WHERE c.tenant_id = ${tenantId}::uuid AND c.kind = ANY(${kinds}::text[])
    `;
    return JSON.stringify(rows[0]!.rows);
  }

  /** Spielt festgehaltene, authentische Checkpoint-Zeilen wieder ein. */
  async function replayRows(tx: EvidenceTx, kinds: VerifyCheckpointKind[], captured: string) {
    await tx.$executeRaw`
      DELETE FROM audit_verify_checkpoint
      WHERE tenant_id = ${tenantId}::uuid AND kind = ANY(${kinds}::text[])
    `;
    await tx.$executeRaw`
      INSERT INTO audit_verify_checkpoint
      SELECT * FROM jsonb_populate_recordset(NULL::audit_verify_checkpoint, ${captured}::jsonb)
    `;
  }

  /** Alle Felder außer Policy-Verstößen und Prüfumfang wie verifyChain. */
  async function expectChainFindingsAsVerifyChain(tx: EvidenceTx, result: VerificationResult) {
    const { policyBreaks: _p, ok: _ok, incremental: _i, ...rest } = result;
    const { policyBreaks: _rp, ok: _rok, ...reference } = await service.verifyChain(tx, tenantId);
    expect(rest).toEqual(reference);
  }

  it('erster Lauf prüft ab Genesis abschnittsweise wie verifyChain und setzt den Checkpoint', async () => {
    await inRollback(async (tx) => {
      const today = new Date();
      const yesterday = new Date(today.getTime() - DAY);
      await recordAt(tx, yesterday, 9);
      await service.sealDay(tx, tenantId, yesterday);
      await record(tx, 4);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 6);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 3);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 5); // lokal noch nicht verankert

      const result = await run(tx);
      const reference = await expectSameAsVerifyChain(tx, result);

      expect(reference).toMatchObject({
        ok: true,
        checked: 27,
        sealsChecked: 1,
        anchorsChecked: 3,
      });
      expect(reference.unanchoredEntries).toBe(5);
      expect(result.incremental).toMatchObject({
        mode: 'full',
        startAuditId: null,
        rowsHashed: 27,
        fullVerification: null,
      });
      const checkpoint = await stored(tx, 'INCREMENTAL');
      expect(checkpoint?.cursor).toMatchObject({
        auditId: result.lastAuditId,
        auditCount: 27,
        sealsChecked: 1,
        anchorsChecked: 3,
        anchorsTrustAnchored: 3,
      });
      expect(checkpoint?.completedAt).toBeInstanceOf(Date);
    });
  });

  it('Folgelauf hasht nur den Zuwachs und prüft nachträgliche Siegel und Anker unterhalb des Checkpoints', async () => {
    await inRollback(async (tx) => {
      const yesterday = new Date(Date.now() - DAY);
      await recordAt(tx, yesterday, 5);
      await record(tx, 10);
      const first = await run(tx);
      const checkpointId = first.lastAuditId!;

      // Erst NACH dem Prüflauf: Tagessiegel für gestern und Anker über die
      // bereits geprüfte Spitze — beide binden Einträge unterhalb des Checkpoints.
      await service.sealDay(tx, tenantId, yesterday);
      const anchored = await service.anchorLatest(tx, tenantId);
      expect(anchored).toMatchObject({ anchored: true, topAuditId: checkpointId });
      await record(tx, 4);

      const second = await run(tx);
      await expectSameAsVerifyChain(tx, second);
      expect(second).toMatchObject({ ok: true, checked: 19, sealsChecked: 1, anchorsChecked: 1 });
      expect(second.incremental).toMatchObject({
        mode: 'incremental',
        startAuditId: checkpointId,
        rowsHashed: 4,
      });
    });
  });

  it('erkennt ein nachträglich angelegtes, ungültiges Siegel unterhalb des Checkpoints', async () => {
    await inRollback(async (tx) => {
      await record(tx, 6);
      const first = await run(tx);
      const top = await nthAuditId(tx, 2);
      await tx.$executeRaw`
        INSERT INTO audit_seal (tenant_id, seal_date, top_audit_id, top_hash,
                                tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at)
        SELECT ${tenantId}::uuid, DATE '2000-01-01', id, this_hash,
               NULL, ${sha256('fremder-token')}, 'x', now()
        FROM audit_log WHERE id = ${top}
      `;

      const second = await run(tx);
      await expectSameAsVerifyChain(tx, second);
      expect(second.ok).toBe(false);
      expect(second.sealBreaks[0]?.reason).toMatch(/TSA-Verifikation gegen rekonstruierten/);
      // Der Siegelbefund stoppt die Prüfung nicht: Der Checkpoint schreitet fort
      // und hält den Befund, der Folgelauf meldet ihn wie verifyChain erneut.
      const checkpoint = await stored(tx, 'INCREMENTAL');
      expect(checkpoint?.cursor.auditId).toBe(first.lastAuditId);
      expect(checkpoint?.cursor.sealsChecked).toBe(1);
      expect(checkpoint?.findings.seals).toHaveLength(1);
      await record(tx, 2);
      const third = await run(tx);
      await expectSameAsVerifyChain(tx, third);
      expect(third.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 2 });
      expect(third.sealBreaks).toHaveLength(1);
    });
  });

  it('meldet bei einem nachträglichen Siegel auf manipulierter Historie den ersten Bruch wie verifyChain', async () => {
    await inRollback(async (tx) => {
      const yesterday = new Date(Date.now() - DAY);
      await recordAt(tx, yesterday, 4);
      await record(tx, 4);
      const first = await run(tx);
      const [earlier, sealedTop] = [await nthAuditId(tx, 1), await nthAuditId(tx, 3)];
      for (const id of [earlier, sealedTop]) {
        await tamper(
          tx,
          'audit_log',
          'audit_log_no_modify',
          `UPDATE audit_log SET action = 'test.manipuliert' WHERE id = ${id}`,
        );
      }
      // Das Tagessiegel bindet den (gespeicherten) Hash der manipulierten Spitze.
      await service.sealDay(tx, tenantId, yesterday);

      const result = await run(tx);
      await expectSameAsVerifyChain(tx, result);
      expect(result.firstBreak?.auditId).toBe(earlier);
      expect(result.checked).toBe(1);
      expect(result.incremental?.startAuditId).toBeNull();
      expect(first.lastAuditId).not.toBeNull();
    });
  });

  it('meldet einen Bruch im Zuwachs wie verifyChain', async () => {
    await inRollback(async (tx) => {
      await record(tx, 5);
      await run(tx);
      await record(tx, 5);
      const victim = await nthAuditId(tx, 7);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET action = 'test.manipuliert' WHERE id = ${victim}`,
      );

      const result = await run(tx);
      await expectSameAsVerifyChain(tx, result);
      expect(result.firstBreak?.auditId).toBe(victim);
      expect(result.checked).toBe(7);
    });
  });

  it('erkennt eine manipulierte Checkpoint-Zeile der Kette sofort', async () => {
    await inRollback(async (tx) => {
      await record(tx, 8);
      const first = await run(tx);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET "after" = '{"i":"manipuliert"}' WHERE id = ${first.lastAuditId}`,
      );

      const result = await run(tx);
      expect(result.ok).toBe(false);
      expect(result.policyBreaks[0]).toMatch(
        /Prüf-Checkpoint passt nicht zur gespeicherten Kette: Audit-Eintrag \d+ reproduziert/,
      );
      // Neuprüfung ab Genesis im selben Lauf liefert den Bruch wie verifyChain.
      expect(result.firstBreak?.auditId).toBe(first.lastAuditId);
      expect(result.incremental?.startAuditId).toBeNull();
    });
  });

  it('erkennt einen ohne Schlüssel veränderten Checkpoint und prüft ab Genesis neu', async () => {
    const cases = [
      `UPDATE audit_verify_checkpoint SET audit_hash = '\\x${'ab'.repeat(32)}'`,
      `UPDATE audit_verify_checkpoint SET audit_count = audit_count - 1`,
      `UPDATE audit_verify_checkpoint SET anchors_checked = 0, anchors_trust_anchored = 0`,
      `UPDATE audit_verify_checkpoint SET completed_at = '2999-01-01'`,
    ];
    for (const forge of cases) {
      await inRollback(async (tx) => {
        await record(tx, 6);
        await service.anchorLatest(tx, tenantId);
        await record(tx, 2);
        await run(tx);
        await tx.$executeRawUnsafe(`${forge} WHERE tenant_id = '${tenantId}'`);

        const result = await run(tx);
        expect(result.ok).toBe(false);
        expect(result.policyBreaks).toHaveLength(1);
        expect(result.policyBreaks[0]).toMatch(
          /^Prüf-Checkpoint ist nicht authentisch: Prüfsumme \(MAC\)/,
        );
        // Die Kette selbst ist intakt: alle übrigen Befunde wie verifyChain.
        const { policyBreaks: _p, ok: _ok, ...rest } = result;
        const reference = await service.verifyChain(tx, tenantId);
        const { policyBreaks: _rp, ok: _rok, ...referenceRest } = reference;
        expect({ ...rest, incremental: undefined }).toEqual({
          ...referenceRest,
          incremental: undefined,
        });
        expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
        // Danach ist der Checkpoint neu aufgebaut und der Folgelauf wieder grün.
        expect((await run(tx)).ok).toBe(true);
      });
    }
  });

  it('erkennt einen unterhalb des Checkpoints gelöschten Rolling-Anker', async () => {
    await inRollback(async (tx) => {
      await record(tx, 3);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 3);
      await service.anchorLatest(tx, tenantId);
      await run(tx);
      await tamper(
        tx,
        'audit_anchor',
        'audit_anchor_no_modify',
        `DELETE FROM audit_anchor WHERE id = (
           SELECT min(id) FROM audit_anchor WHERE tenant_id = '${tenantId}')`,
      );

      const result = await run(tx);
      expect(result.ok).toBe(false);
      expect(result.policyBreaks[0]).toMatch(/1 statt 2 Rolling-Anker/);
      expect(result.anchorBreaks[0]?.reason).toMatch(/Vorgängerkette|überlappender/);
    });
  });

  it('findet eine Manipulation unterhalb des Checkpoints in der fortsetzbaren Vollprüfung', async () => {
    await inRollback(async (tx) => {
      await record(tx, 12);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 12);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 6);
      await run(tx);
      // Liegt im zweiten Abschnitt (je 7 Zeilen) der späteren Vollprüfung.
      const victim = await nthAuditId(tx, 10);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET resource_type = 'manipuliert' WHERE id = ${victim}`,
      );

      // Zuwachsprüfung ohne fällige Vollprüfung: bewusst kein Re-Hash der Historie.
      const daily = await run(tx);
      expect(daily.ok).toBe(true);
      expect(daily.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 0 });

      // Manuell angestoßene Vollprüfung, ein Abschnitt je Lauf (Budget 0).
      const started = await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      expect(started.ok).toBe(true);
      expect(started.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 7 });
      expect(started.incremental?.fullVerification).toMatchObject({
        auditId: await nthAuditId(tx, 6),
        targetAuditId: await lastAuditId(tx),
      });
      expect(await stored(tx, 'FULL')).not.toBeNull();

      const resumed = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(resumed.ok).toBe(false);
      expect(resumed.firstBreak?.auditId).toBe(victim);
      expect(resumed.firstBreak).toEqual((await service.verifyChain(tx, tenantId)).firstBreak);
      expect(resumed.checked).toBe(10);
      expect(await stored(tx, 'INCREMENTAL')).toBeNull();
      expect(await stored(tx, 'FULL')).toBeNull();
    });
  });

  it('schließt eine fortsetzbare Vollprüfung über mehrere Läufe ab und bestätigt den Checkpoint', async () => {
    await inRollback(async (tx) => {
      const yesterday = new Date(Date.now() - DAY);
      await recordAt(tx, yesterday, 10);
      await service.sealDay(tx, tenantId, yesterday);
      for (let i = 0; i < 5; i++) {
        await record(tx, 3);
        await service.anchorLatest(tx, tenantId);
      }
      const first = await run(tx);
      const clock = () => new Date(Date.now() + 8 * DAY); // Vollprüfung fällig

      const runs: VerificationResult[] = [];
      for (let i = 0; i < 20; i++) {
        const next = await run(tx, { fullVerifyBudgetMs: 0, now: clock });
        runs.push(next);
        if (next.incremental?.mode === 'full') break;
      }
      const last = runs.at(-1)!;
      expect(runs.length).toBeGreaterThan(2);
      expect(runs.every((r) => r.ok)).toBe(true);
      expect(last.incremental).toMatchObject({ mode: 'full', fullVerification: null });
      expect(last.incremental?.lastFullVerifiedAt?.getTime()).toBeGreaterThan(
        first.incremental!.lastFullVerifiedAt!.getTime(),
      );
      await expectSameAsVerifyChain(tx, last);
      expect(await stored(tx, 'FULL')).toBeNull();
      expect(await stored(tx, 'FULL_TARGET')).toBeNull();
      // Die Vollprüfung hat jede Zeile erneut gehasht.
      const rehashed = runs.reduce((sum, r) => sum + (r.incremental?.rowsHashed ?? 0), 0);
      expect(rehashed).toBe(first.checked);
    });
  });

  it('erkennt einen manipulierten Fortschritt der Vollprüfung', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      // Fortschritt vorschieben, um einen Abschnitt zu überspringen.
      const skipTo = await nthAuditId(tx, 15);
      await tx.$executeRaw`
        UPDATE audit_verify_checkpoint SET audit_id = ${skipTo}
        WHERE tenant_id = ${tenantId}::uuid AND kind = 'FULL'
      `;

      const result = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.policyBreaks[0]).toMatch(
        /^Stand der Vollprüfung ist nicht authentisch: Prüfsumme \(MAC\)/,
      );
      expect(await stored(tx, 'INCREMENTAL')).toBeNull();
    });
  });

  it('lädt Rolling-Anker blockweise und begrenzt jeden Abschnitt auf seinen Ankerblock', async () => {
    await inRollback(async (tx) => {
      const tops: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        await record(tx, 2);
        const anchored = await service.anchorLatest(tx, tenantId);
        if (!anchored.anchored) throw new Error(anchored.reason);
        tops.push(anchored.topAuditId);
      }
      await record(tx, 1);
      const anchorRows = await tx.$queryRaw<Array<{ max_anchor_id: bigint }>>`
        SELECT max(id) AS max_anchor_id FROM audit_anchor WHERE tenant_id = ${tenantId}::uuid
      `;
      const maxAnchorId = anchorRows[0]!.max_anchor_id;
      const bounds = { maxAuditId: null, maxSealId: 0n, maxAnchorId };

      let cursor = genesisCursor(tenantId);
      const segments: Array<[bigint, number, boolean]> = [];
      for (let i = 0; i < 10; i++) {
        const segment = await service.verifyChainSegment(tx, tenantId, cursor, bounds, {
          maxRows: 1_000,
          maxAnchors: 2,
        });
        expect(segment.ok).toBe(true);
        cursor = segment.cursor;
        segments.push([cursor.auditId, cursor.anchorsChecked, segment.complete]);
        if (segment.complete) break;
      }

      expect(segments).toEqual([
        [tops[1], 2, false],
        [tops[3], 4, false],
        [await lastAuditId(tx), 5, true],
      ]);
      expect(cursor.anchorsTrustAnchored).toBe(5);
      expect(cursor.auditCount).toBe(11);
    });
  });

  it('übernimmt Unanchored-Policy und Self-Timestamp-Policy wie verifyChain', async () => {
    await inRollback(async (tx) => {
      await recordAt(tx, new Date(Date.now() - 2 * DAY), 3);
      const result = await run(tx, { maxUnanchoredAgeMs: 60_000 });
      const reference = await service.verifyChain(tx, tenantId, { maxUnanchoredAgeMs: 60_000 });
      const { incremental: _scope, ...comparable } = result;
      expect(comparable).toEqual(reference);
      expect(result.policyBreaks.join(' ')).toMatch(/ohne externen RFC-3161-Anker/);
      expect(await lastAuditId(tx)).toBe(result.lastAuditId);

      const local = new EvidenceService(new LocalTimestampAdapter());
      const localResult = await verifyChainWithCheckpoints(
        local,
        (work) => work(tx),
        tenantId,
        options({ requireExternalTsa: true }),
      );
      const localReference = await local.verifyChain(tx, tenantId, { requireExternalTsa: true });
      const { incremental: _localScope, ...localComparable } = localResult;
      expect(localComparable).toEqual(localReference);
      expect(localResult.tsaMode).toBe('local');
      expect(localResult.policyBreaks.join(' ')).toMatch(/Produktivmodus unzulässig/);
    });
  });

  it('Review P-04: Siegelbefund friert nicht ein, späterer Kettenbruch wie verifyChain', async () => {
    await inRollback(async (tx) => {
      await record(tx, 10);
      await run(tx);
      await insertBogusSeal(tx, await nthAuditId(tx, 2), '2000-01-03');
      await record(tx, 40);
      const victim = await nthAuditId(tx, 39);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET action = 'test.manipuliert' WHERE id = ${victim}`,
      );

      for (let i = 0; i < 2; i++) {
        const result = await run(tx);
        const reference = await expectSameAsVerifyChain(tx, result);
        expect(reference.firstBreak?.auditId).toBe(victim);
        expect(result.checked).toBe(39);
      }
    });
  });

  it('Review P-04: Siegel mit niedriger ID friert den Genesis-Walk nicht ein', async () => {
    await inRollback(async (tx) => {
      const yesterday = new Date(Date.now() - DAY);
      await recordAt(tx, yesterday, 4);
      await service.sealDay(tx, tenantId, yesterday);
      await record(tx, 20);
      await run(tx);
      await insertBogusSeal(tx, await nthAuditId(tx, 2), '2000-01-04', -4711n);

      const result = await run(tx);
      expect(result.policyBreaks[0]).toMatch(
        /^Prüf-Checkpoint passt nicht zur gespeicherten Kette: 2 statt 1 Tagesversiegelungen/,
      );
      // Kein Einfrieren: geprüft bis zur Spitze, also kein falscher Tail-Truncation-Befund.
      expect(result.checked).toBe(24);
      expect(result.lastAuditId).toBe(await lastAuditId(tx));
      expect(result.sealBreaks).toHaveLength(1);
      await expectSameAsVerifyChain(tx, await run(tx));
    });
  });

  it('Review P-04: Zuwachs über mehrere Abschnitte mit frühem Siegel- und Ankerbefund wie verifyChain', async () => {
    await inRollback(async (tx) => {
      await record(tx, 4);
      await service.anchorLatest(tx, tenantId);
      await record(tx, 2);
      await run(tx);
      await record(tx, 3);
      await insertBogusAnchor(tx);
      await insertBogusSeal(tx, await nthAuditId(tx, 1), '2000-01-05');
      for (let i = 0; i < 6; i++) {
        await record(tx, 3);
        const anchored = await service.anchorLatest(tx, tenantId);
        if (!anchored.anchored) throw new Error(anchored.reason);
      }

      const result = await run(tx);
      const reference = await expectSameAsVerifyChain(tx, result);
      expect(reference.ok).toBe(false);
      expect(reference.sealBreaks).toHaveLength(1);
      expect(reference.anchorBreaks).toHaveLength(7);
      expect(result.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 21 });
      await record(tx, 1);
      await expectSameAsVerifyChain(tx, await run(tx));
    });
  });

  it('Review P-04: mit Schlüssel gefälschter Checkpoint fällt am Kettenabgleich auf', async () => {
    await inRollback(async (tx) => {
      await record(tx, 6);
      await run(tx);
      const checkpoint = (await stored(tx))!;
      await forge(tx, {
        ...checkpoint,
        cursor: { ...checkpoint.cursor, auditCount: checkpoint.cursor.auditCount - 1 },
      });
      const result = await run(tx);
      expect(result.policyBreaks).toEqual([
        expect.stringMatching(
          /^Prüf-Checkpoint passt nicht zur gespeicherten Kette: 6 statt 5 Audit-Einträge/,
        ),
      ]);
      expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
    });
  });

  it('Review P-04: in die Zukunft datierter Checkpoint gilt als nicht authentisch', async () => {
    await inRollback(async (tx) => {
      await record(tx, 3);
      await run(tx);
      const checkpoint = (await stored(tx))!;
      await forge(tx, { ...checkpoint, completedAt: new Date(Date.now() + 365 * DAY) });
      const result = await run(tx);
      expect(result.ok).toBe(false);
      expect(result.policyBreaks[0]).toMatch(
        /^Prüf-Checkpoint ist nicht authentisch: Zeitstempel liegt in der Zukunft/,
      );
      expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
    });
  });

  it('Review P-04: kopierter Vollprüfungsstand ist nicht authentisch', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      await tx.$executeRaw`
        UPDATE audit_verify_checkpoint f
        SET audit_id = t.audit_id, audit_hash = t.audit_hash, audit_count = t.audit_count,
            seal_id = t.seal_id, seals_checked = t.seals_checked,
            anchor_id = t.anchor_id, anchor_hash = t.anchor_hash,
            anchor_top_audit_id = t.anchor_top_audit_id, anchors_checked = t.anchors_checked,
            findings = t.findings, mac = t.mac
        FROM audit_verify_checkpoint t
        WHERE f.tenant_id = ${tenantId}::uuid AND f.kind = 'FULL'
          AND t.tenant_id = ${tenantId}::uuid AND t.kind = 'FULL_TARGET'
      `;
      const result = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.policyBreaks[0]).toMatch(
        /^Stand der Vollprüfung ist nicht authentisch: Prüfsumme \(MAC\)/,
      );
      expect(await stored(tx, 'INCREMENTAL')).toBeNull();
    });
  });

  it('Review P-04: eine seit Tagen stehende Vollprüfung meldet „Vollprüfung stockt“ und beginnt neu', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      const later = new Date(Date.now() + 4 * DAY);
      const result = await run(tx, {
        forceFullVerify: true,
        fullVerifyBudgetMs: 0,
        now: () => later,
      });
      expect(result.ok).toBe(false);
      expect(result.policyBreaks).toEqual([expect.stringMatching(/^Vollprüfung stockt: /)]);
      expect(result.incremental?.fullVerification?.startedAt.getTime()).toBe(later.getTime());
    });
  });

  it('Review P-04: ein parallel überholter Lauf übernimmt dessen Stand und meldet vollständig', async () => {
    await inRollback(async (tx) => {
      await record(tx, 5);
      await run(tx);
      await record(tx, 3);
      let calls = 0;
      const racing = async <T>(work: (t: EvidenceTx) => Promise<T>): Promise<T> => {
        if (++calls === 4) await run(tx);
        return work(tx);
      };
      const result = await verifyChainWithCheckpoints(service, racing, tenantId, options());
      // Kein Überspringen: Der Lauf übernimmt den später geschriebenen,
      // authentischen Stand des parallelen Laufs und prüft bis zur Spitze.
      await expectSameAsVerifyChain(tx, result);
      expect(result.policyBreaks).toEqual([]);
      expect((await stored(tx))?.cursor.auditCount).toBe(8);
    });
  });

  it('Review P-04: ein während des Laufs verfälschter Checkpoint ist kein paralleler Lauf', async () => {
    await inRollback(async (tx) => {
      await record(tx, 5);
      await run(tx);
      await record(tx, 3);
      let calls = 0;
      const tampering = async <T>(work: (t: EvidenceTx) => Promise<T>): Promise<T> => {
        if (++calls === 4) {
          await tx.$executeRaw`
            UPDATE audit_verify_checkpoint SET mac = ${Buffer.alloc(32)}
            WHERE tenant_id = ${tenantId}::uuid
          `;
        }
        return work(tx);
      };
      const result = await verifyChainWithCheckpoints(service, tampering, tenantId, options());
      expect(result.policyBreaks).toEqual([
        expect.stringMatching(
          /^Prüf-Checkpoint wurde während des Prüflaufs verändert: Prüfsumme \(MAC\).*\(Manipulationsverdacht\)\. Checkpoint verworfen; Kette ab Genesis neu geprüft\.$/,
        ),
      ]);
      // Neuprüfung ab Genesis im selben Lauf; übrige Befunde wie verifyChain.
      expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
      await expectChainFindingsAsVerifyChain(tx, result);
      expect((await run(tx)).ok).toBe(true);
    });
  });

  it('Review R1 (S7): ein während des Laufs gelöschter Checkpoint ist ein Befund, kein paralleler Lauf', async () => {
    await inRollback(async (tx) => {
      await record(tx, 5);
      await run(tx);
      await record(tx, 20);
      // Jenseits des ersten Abschnitts (7 Zeilen) dieses Laufs.
      const victim = await nthAuditId(tx, 20);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET action = 'test.manipuliert' WHERE id = ${victim}`,
      );
      // Angreifer ohne Schlüssel löscht die Checkpoints vor jeder Transaktion.
      const deleting = async <T>(work: (t: EvidenceTx) => Promise<T>): Promise<T> => {
        await tx.$executeRaw`
          DELETE FROM audit_verify_checkpoint WHERE tenant_id = ${tenantId}::uuid
        `;
        return work(tx);
      };
      const result = await verifyChainWithCheckpoints(service, deleting, tenantId, options());
      expect(result.ok).toBe(false);
      expect(result.policyBreaks.length).toBeGreaterThan(0);
      for (const reason of result.policyBreaks) {
        expect(reason).toMatch(
          /^Prüf-Checkpoint wurde während des Prüflaufs gelöscht \(Manipulationsverdacht\)/,
        );
      }
      // Trotz wiederholter Eingriffe prüft der Lauf bis zum Bruch weiter.
      expect(result.firstBreak?.auditId).toBe(victim);
      expect(result.firstBreak).toEqual((await service.verifyChain(tx, tenantId)).firstBreak);
    });
  });

  it('Review R1: ein während des Laufs durch einen älteren authentischen Stand ersetzter Checkpoint ist ein Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 5);
      await run(tx);
      const older = await captureRows(tx, ['INCREMENTAL']);
      await record(tx, 3);
      await run(tx);
      await record(tx, 10);
      let calls = 0;
      const replaying = async <T>(work: (t: EvidenceTx) => Promise<T>): Promise<T> => {
        if (++calls === 5) await replayRows(tx, ['INCREMENTAL'], older);
        return work(tx);
      };
      const result = await verifyChainWithCheckpoints(service, replaying, tenantId, options());
      expect(result.policyBreaks).toEqual([
        expect.stringMatching(
          /^Prüf-Checkpoint wurde während des Prüflaufs durch einen älteren Stand ersetzt \(Manipulationsverdacht\)/,
        ),
      ]);
      expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
      await expectChainFindingsAsVerifyChain(tx, result);
    });
  });

  it('Review R2 (S5): ein gelöschter Stand der laufenden Vollprüfung ist ein Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      // Liegt im zweiten Abschnitt (je 7 Zeilen) der Vollprüfung.
      const victim = await nthAuditId(tx, 10);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `UPDATE audit_log SET resource_type = 'manipuliert' WHERE id = ${victim}`,
      );
      const started = await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      expect(started.ok).toBe(true);
      // Die Kennung der laufenden Vollprüfung steht prüfsummengeschützt im Checkpoint.
      const bound = (await stored(tx))?.sweepId;
      expect(bound).toEqual(expect.any(String));
      expect((await stored(tx, 'FULL'))?.sweepId).toBe(bound);

      // Angreifer ohne Schlüssel löscht den Stand der Vollprüfung nach jedem Lauf.
      await tx.$executeRaw`
        DELETE FROM audit_verify_checkpoint
        WHERE tenant_id = ${tenantId}::uuid AND kind IN ('FULL', 'FULL_TARGET')
      `;
      const next = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(next.ok).toBe(false);
      expect(next.policyBreaks).toEqual([
        expect.stringMatching(/^Stand der laufenden Vollprüfung fehlt \(Manipulationsverdacht\)/),
      ]);
      expect(await stored(tx)).toBeNull();
      // Der nächste Lauf prüft ab Genesis und findet die Manipulation.
      const rewalk = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(rewalk.firstBreak?.auditId).toBe(victim);
    });
  });

  it('Review R2: ein gelöschter Prüf-Checkpoint neben einem Vollprüfungsstand ist ein Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      await tx.$executeRaw`
        DELETE FROM audit_verify_checkpoint
        WHERE tenant_id = ${tenantId}::uuid AND kind = 'INCREMENTAL'
      `;
      const result = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(result.policyBreaks).toEqual([
        expect.stringMatching(
          /^Prüf-Checkpoint fehlt, obwohl ein Stand der Vollprüfung vorliegt \(Manipulationsverdacht\)/,
        ),
      ]);
      expect(result.incremental).toMatchObject({ mode: 'full', startAuditId: null });
      await expectChainFindingsAsVerifyChain(tx, result);
      expect(await stored(tx, 'FULL')).toBeNull();
      expect((await run(tx)).ok).toBe(true);
    });
  });

  it('Review R2: meldet ohne laufende Vollprüfung eine überfällige', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      const first = await run(tx);
      const day = (n: number) => () => new Date(Date.now() + n * DAY);
      await run(tx, { fullVerifyBudgetMs: 0, now: day(8) });
      // Der Stand der Vollprüfung fehlt: Danach läuft keine Vollprüfung mehr.
      await tx.$executeRaw`
        DELETE FROM audit_verify_checkpoint
        WHERE tenant_id = ${tenantId}::uuid AND kind IN ('FULL', 'FULL_TARGET')
      `;
      const late = await run(tx, { fullVerifyBudgetMs: 0, now: day(22) });
      expect(late.incremental?.fullVerification).toBeNull();
      expect(late.policyBreaks).toEqual([
        expect.stringMatching(/^Stand der laufenden Vollprüfung fehlt \(Manipulationsverdacht\)/),
        `Vollprüfung überfällig: Die letzte abgeschlossene Vollprüfung ab Genesis ` +
          `(${first.incremental!.lastFullVerifiedAt!.toISOString()}) liegt mehr als 21 Tage zurück.`,
      ]);
      // Der Genesis-Walk des nächsten Laufs ist die Vollprüfung.
      const rewalk = await run(tx, { now: day(23) });
      expect(rewalk.incremental).toMatchObject({ mode: 'full', fullVerification: null });
      expect(rewalk.policyBreaks).toEqual([]);
    });
  });

  it('Review N2: eine fortschreitende Vollprüfung ist nie überfällig, eine stockende meldet das', async () => {
    await inRollback(async (tx) => {
      await record(tx, 40); // sechs Abschnitte zu höchstens 7 Zeilen
      await run(tx);
      const day = (n: number) => () => new Date(Date.now() + n * DAY);
      // Ein Abschnitt je täglichem Lauf ab Tag 20: Die Vollprüfung läuft über die
      // 21-Tage-Grenze hinaus und meldet dabei nichts.
      const daily: VerificationResult[] = [];
      for (let n = 20; n < 40; n++) {
        const result = await run(tx, { fullVerifyBudgetMs: 0, now: day(n) });
        daily.push(result);
        if (result.incremental?.mode === 'full') break;
      }
      expect(daily.length).toBeGreaterThan(3);
      expect(daily.at(-1)?.incremental?.mode).toBe('full');
      expect(daily.flatMap((result) => result.policyBreaks)).toEqual([]);
      expect(daily.every((result) => result.ok)).toBe(true);

      // Die nächste Vollprüfung beginnt und macht dann über drei Tage keinen Fortschritt.
      const completedOn = 19 + daily.length;
      const started = await run(tx, { fullVerifyBudgetMs: 0, now: day(completedOn + 8) });
      expect(started.incremental?.fullVerification).not.toBeNull();
      expect(started.policyBreaks).toEqual([]);
      const stalled = await run(tx, { fullVerifyBudgetMs: 0, now: day(completedOn + 12.5) });
      expect(stalled.ok).toBe(false);
      expect(stalled.policyBreaks).toEqual([expect.stringMatching(/^Vollprüfung stockt: /)]);
      // Sie beginnt neu; die neue Vollprüfung schreitet wieder ohne Befund fort.
      expect(stalled.incremental!.fullVerification!.startedAt.getTime()).toBeGreaterThan(
        started.incremental!.fullVerification!.startedAt.getTime(),
      );
      const resumed = await run(tx, { fullVerifyBudgetMs: 0, now: day(completedOn + 13.5) });
      expect(resumed.policyBreaks).toEqual([]);
    });
  });

  it('Review R3 (S6): ein Siegel mit Spitze jenseits des Kettenendes ist ein Siegelbefund, kein Checkpoint-Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 6);
      await run(tx);
      // Wie ein Insert der App-Rolle: Siegel auf eine nicht vorhandene Spitze.
      const beyond = (await lastAuditId(tx)) + 1_000_000n;
      await tx.$executeRaw`
        INSERT INTO audit_seal (tenant_id, seal_date, top_audit_id, top_hash,
                                tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at)
        VALUES (${tenantId}::uuid, DATE '2000-02-01', ${beyond}, ${sha256('nirgends')},
                NULL, ${sha256('fremd')}, 'x', now())
      `;
      for (let i = 0; i < 3; i++) {
        const result = await run(tx);
        await expectSameAsVerifyChain(tx, result);
        expect(result.policyBreaks).toEqual([]);
        expect(result.sealsChecked).toBe(1);
        expect(result.sealBreaks).toEqual([
          expect.objectContaining({
            reason: expect.stringMatching(/fehlt in der rekonstruierten Kette/),
          }),
        ]);
        // Kein Genesis-Walk: nur der (leere) Zuwachs ab dem Checkpoint.
        expect(result.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 0 });
      }
    });
  });

  it('Review R3 (S6): eine abgeschnittene versiegelte Spitze meldet den Checkpoint-Befund einmal, danach wie verifyChain', async () => {
    await inRollback(async (tx) => {
      const yesterday = new Date(Date.now() - DAY);
      await recordAt(tx, yesterday, 4);
      await service.sealDay(tx, tenantId, yesterday);
      await run(tx);
      const top = await lastAuditId(tx);
      await tamper(
        tx,
        'audit_log',
        'audit_log_no_modify',
        `DELETE FROM audit_log WHERE id = ${top}`,
      );

      const truncated = await run(tx);
      expect(truncated.policyBreaks).toEqual([
        expect.stringMatching(
          new RegExp(
            `^Prüf-Checkpoint passt nicht zur gespeicherten Kette: Audit-ID ${top} existiert nicht mehr`,
          ),
        ),
      ]);
      await expectChainFindingsAsVerifyChain(tx, truncated);
      for (let i = 0; i < 2; i++) {
        const result = await run(tx);
        await expectSameAsVerifyChain(tx, result);
        expect(result.policyBreaks).toEqual([]);
        expect(result.sealBreaks).toHaveLength(1);
        expect(result.incremental).toMatchObject({ mode: 'incremental', rowsHashed: 0 });
      }
    });
  });

  it('Review R4: ein wieder eingespielter Vollprüfungsstand schließt keine Vollprüfung ab', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      // Den Stand unmittelbar vor dem abschließenden Abschnitt festhalten.
      let captured = '';
      for (let i = 0; i < 10; i++) {
        const pair = await captureRows(tx, ['FULL', 'FULL_TARGET']);
        const result = await run(tx, { fullVerifyBudgetMs: 0 });
        if (result.incremental?.mode === 'full') {
          captured = pair;
          break;
        }
      }
      expect(JSON.parse(captured)).toHaveLength(2);
      expect(await stored(tx, 'FULL')).toBeNull();

      await replayRows(tx, ['FULL', 'FULL_TARGET'], captured);
      const replayed = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(replayed.ok).toBe(false);
      expect(replayed.policyBreaks).toEqual([
        expect.stringMatching(
          /^Stand einer nicht laufenden Vollprüfung vorgefunden \(wieder eingespielt\) \(Manipulationsverdacht\)/,
        ),
      ]);
      expect(replayed.incremental?.mode).toBe('incremental');
      expect(await stored(tx)).toBeNull();
    });
  });

  it('Review R4: eine vor der letzten abgeschlossenen Vollprüfung begonnene Vollprüfung schließt nicht ab', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      // Zweite Absicherung neben der Kennung: Selbst mit Schlüssel und passender
      // Kennung schließt keine Vollprüfung ab, die vor der letzten begann.
      const checkpoint = (await stored(tx))!;
      expect(checkpoint.sweepId).toEqual(expect.any(String));
      await forge(tx, { ...checkpoint, completedAt: new Date() });

      const result = await run(tx);
      expect(result.policyBreaks).toEqual([
        expect.stringMatching(
          /^Stand der Vollprüfung stammt nicht aus der laufenden Vollprüfung \(Manipulationsverdacht\)/,
        ),
      ]);
      expect(await stored(tx)).toBeNull();
    });
  });

  it('Review R5: über 1.000 Befunde speichern Zuwachs- und Vollprüfung gleich; die Vollprüfung schließt ab', async () => {
    await inRollback(async (tx) => {
      await record(tx, 10);
      const top = await nthAuditId(tx, 4);
      await insertBogusSeals(tx, top, '2010-01-01', 600);
      await run(tx);
      // Höhere IDs, aber frühere Daten: Die Zuwachsprüfung verarbeitet sie
      // nachträglich, die Vollprüfung in Datumsreihenfolge vor den ersten 600.
      await insertBogusSeals(tx, top, '1990-01-01', 600);
      const daily = await run(tx);
      const omitted = `200 weitere Siegel-/Ankerbefunde nicht einzeln gespeichert (mehr als ${MAX_STORED_FINDINGS} je Art).`;
      expect(daily.policyBreaks).toEqual([omitted]);
      expect(daily.sealBreaks).toHaveLength(MAX_STORED_FINDINGS);
      const before = (await stored(tx))!;

      const swept = await run(tx, { now: () => new Date(Date.now() + 8 * DAY) });
      // Gleicher gespeicherter Ausschnitt: kein Rücksetzen, Vollprüfung abgeschlossen.
      expect(swept.incremental).toMatchObject({ mode: 'full', fullVerification: null });
      expect(swept.policyBreaks).toEqual([omitted]);
      const after = (await stored(tx))!;
      expect(after.findings).toEqual(before.findings);
      expect(after.completedAt!.getTime()).toBeGreaterThan(before.completedAt!.getTime());
      expect(after.findings.seals.map((seal) => BigInt(seal.id))).toEqual(
        [...after.findings.seals.map((seal) => BigInt(seal.id))].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // B15: Fortschrittsanker im persistierten Prüfergebnis. Der Worker reicht den
  // Anker des vorigen Laufs (result.incremental.progressAnchor) in den nächsten.
  // ---------------------------------------------------------------------------
  function anchorOf(result: VerificationResult) {
    return result.incremental?.progressAnchor ?? null;
  }

  it('B15: Folgeläufe mit dem Anker des Vorlaufs schließen eine Vollprüfung befundfrei ab', async () => {
    await inRollback(async (tx) => {
      await record(tx, 40);
      let previous = await run(tx);
      expect(anchorOf(previous)).toMatchObject({
        sweep: null,
        mac: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const day = (n: number) => () => new Date(Date.now() + n * DAY);
      const daily: VerificationResult[] = [];
      for (let n = 8; n < 30; n++) {
        await record(tx, 1);
        previous = await run(tx, {
          fullVerifyBudgetMs: 0,
          now: day(n),
          progressAnchor: anchorOf(previous),
        });
        daily.push(previous);
        if (previous.incremental?.mode === 'full') break;
      }
      expect(daily.length).toBeGreaterThan(3);
      expect(daily.at(-1)?.incremental?.mode).toBe('full');
      expect(daily.flatMap((result) => result.policyBreaks)).toEqual([]);
      // Während der Vollprüfung hält der Anker deren Fortschritt fest.
      expect(anchorOf(daily[0]!)?.sweep).toMatchObject({ sweepId: expect.any(String) });
      expect(anchorOf(daily.at(-1)!)?.sweep).toBeNull();
      expect((await stored(tx, 'INCREMENTAL', day(60)()))?.sweepId).toBeNull();
    });
  });

  it('B15: ein zwischen zwei Läufen wieder eingespielter früherer Vollprüfungsstand ist ein Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 40);
      await run(tx);
      const started = await run(tx, { forceFullVerify: true, fullVerifyBudgetMs: 0 });
      const earlier = await captureRows(tx, ['FULL']);
      const advanced = await run(tx, {
        fullVerifyBudgetMs: 0,
        progressAnchor: anchorOf(started),
      });
      expect(advanced.policyBreaks).toEqual([]);
      const reached = anchorOf(advanced)!.sweep!;
      expect(BigInt(reached.auditId)).toBeGreaterThan(BigInt(anchorOf(started)!.sweep!.auditId));

      // Angreifer ohne Schlüssel spielt einen früheren, authentischen Stand
      // derselben Vollprüfung zurück (jünger als drei Tage, also kein „stockt“).
      await replayRows(tx, ['FULL'], earlier);
      // Ohne Anker (Ergebnis von vor B15) bliebe das unbemerkt.
      const unnoticed = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(unnoticed.policyBreaks).toEqual([]);

      await replayRows(tx, ['FULL'], earlier);
      const detected = await run(tx, {
        fullVerifyBudgetMs: 0,
        progressAnchor: anchorOf(advanced),
      });
      expect(detected.ok).toBe(false);
      expect(detected.policyBreaks).toEqual([
        expect.stringMatching(
          /^Stand der laufenden Vollprüfung liegt hinter dem im letzten Prüfergebnis festgehaltenen Fortschritt \(Audit-ID \d+ statt mindestens \d+; wieder eingespielt\) \(Manipulationsverdacht\)/,
        ),
      ]);
      expect(await stored(tx)).toBeNull();
      expect(anchorOf(detected)).toBeNull();
      // Der nächste Lauf prüft die Kette ab Genesis vollständig.
      const rewalk = await run(tx, { progressAnchor: anchorOf(detected) });
      expect(rewalk.incremental).toMatchObject({ mode: 'full', startAuditId: null });
      expect(rewalk.policyBreaks).toEqual([]);
      await expectSameAsVerifyChain(tx, rewalk);
    });
  });

  it('B15: ein wieder eingespielter Prüf-Checkpoint von vor dem Start der Vollprüfung ist ein Befund', async () => {
    await inRollback(async (tx) => {
      await record(tx, 40);
      const first = await run(tx);
      const beforeSweep = await captureRows(tx, ['INCREMENTAL']);
      const started = await run(tx, {
        forceFullVerify: true,
        fullVerifyBudgetMs: 0,
        progressAnchor: anchorOf(first),
      });
      expect(started.incremental?.fullVerification).not.toBeNull();
      const dropSweep = () => tx.$executeRaw`
        DELETE FROM audit_verify_checkpoint
        WHERE tenant_id = ${tenantId}::uuid AND kind IN ('FULL', 'FULL_TARGET')
      `;

      // Angreifer: ungebundenen Prüf-Checkpoint zurückspielen und den Stand der
      // Vollprüfung löschen. Ohne Anker sieht das aus, als liefe keine.
      await replayRows(tx, ['INCREMENTAL'], beforeSweep);
      await dropSweep();
      const unnoticed = await run(tx, { fullVerifyBudgetMs: 0 });
      expect(unnoticed.policyBreaks).toEqual([]);

      await replayRows(tx, ['INCREMENTAL'], beforeSweep);
      await dropSweep();
      const detected = await run(tx, {
        fullVerifyBudgetMs: 0,
        progressAnchor: anchorOf(started),
      });
      expect(detected.policyBreaks).toEqual([
        expect.stringMatching(
          /^Prüf-Checkpoint ist älter als der im letzten Prüfergebnis festgehaltene Stand \(geschrieben .+, festgehalten .+; wieder eingespielt\) \(Manipulationsverdacht\)/,
        ),
      ]);
      // Wie jeder verworfene Checkpoint: Neuprüfung ab Genesis im selben Lauf.
      expect(detected.incremental).toMatchObject({ mode: 'full', startAuditId: null });
      await expectChainFindingsAsVerifyChain(tx, detected);
      expect(anchorOf(detected)).toMatchObject({ sweep: null });
    });
  });

  it('B15: ein nicht authentischer oder fremder Anker schaltet nur die Monotonieprüfung ab', async () => {
    await inRollback(async (tx) => {
      await record(tx, 20);
      await run(tx);
      // Vorverlegt: als echter Anker meldete er jeden Prüf-Checkpoint als alt.
      const ahead = {
        incrementalVerifiedAt: new Date(Date.now() + DAY).toISOString(),
        sweep: null,
      };
      const candidates = [
        { ...ahead, mac: '00'.repeat(32) },
        { ...ahead, mac: progressAnchorMac(KEY, randomUUID(), ahead).toString('hex') },
        { ...ahead, mac: progressAnchorMac(Buffer.alloc(32, 8), tenantId, ahead).toString('hex') },
        { ...ahead, incrementalVerifiedAt: 'gestern', mac: 'zz' },
        'kein Anker',
      ];
      for (const progressAnchor of candidates) {
        const result = await run(tx, { progressAnchor: progressAnchor as never });
        expect(result.policyBreaks).toEqual([]);
        expect(result.ok).toBe(true);
      }
      // Gegenprobe: derselbe Anker mit Schlüssel und Tenant wird geprüft.
      const sealed = { ...ahead, mac: progressAnchorMac(KEY, tenantId, ahead).toString('hex') };
      const flagged = await run(tx, { progressAnchor: sealed });
      expect(flagged.policyBreaks).toEqual([
        expect.stringMatching(/^Prüf-Checkpoint ist älter als der im letzten Prüfergebnis/),
      ]);
    });
  });
});
