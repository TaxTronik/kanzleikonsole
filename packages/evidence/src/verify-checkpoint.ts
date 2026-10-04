// =============================================================================
// P-04: Prüf-Checkpoints der täglichen Audit-Kettenprüfung.
//
// Bisher rechnete der Worker jede Nacht die vollständige Kette ab Genesis in
// EINER 120-s-Transaktion nach und lud dafür alle TSA-Antworten auf einmal.
// Jetzt:
//
// 1. Zuwachsprüfung (INCREMENTAL): Ab dem zuletzt geprüften Kettenstand werden
//    nur neue Einträge, Siegel und Rolling-Anker geprüft — abschnittsweise, je
//    Abschnitt eine eigene Transaktion, Fortschritt nach jedem Abschnitt
//    persistiert. Vorher wird der Checkpoint selbst geprüft: Prüfsumme (MAC),
//    Zeitstempel, Zeile und Hash an seiner Position, Anzahl der
//    Einträge/Siegel/Anker bis dorthin, letzter gültiger Anker.
// 2. Vollprüfung (FULL/FULL_TARGET): Periodisch und bei manuellen Läufen wird
//    die Kette ab Genesis erneut vollständig nachgerechnet, fortsetzbar in
//    Abschnitten mit Zeitbudget je Lauf. Ziel ist der beim Start eingefrorene
//    INCREMENTAL-Stand; die Vollprüfung muss ihn am Ende exakt bestätigen. Die
//    Kennung der laufenden Vollprüfung steht prüfsummengeschützt in der
//    INCREMENTAL-Zeile; ein fehlender oder fremder Vollprüfungsstand ist
//    deshalb ein Befund. Eine laufende Vollprüfung ohne Fortschritt seit drei
//    Tagen meldet „Vollprüfung stockt“ und beginnt neu; eine fortschreitende
//    gilt nie als überfällig. Läuft keine, und liegt die letzte abgeschlossene
//    mehr als das Dreifache des Intervalls zurück, meldet jeder Lauf
//    „Vollprüfung überfällig“.
//
// Wie verifyChain: Ein Hash-/Vorgängerbruch beendet die Prüfung und hat
// Vorrang. Siegel- und Ankerbefunde stoppen sie nicht; der Prüfstand wird
// fortgeschrieben und die Befunde werden im Checkpoint (`findings`) gehalten,
// damit jeder Lauf sie erneut meldet. Ein nicht authentischer oder nicht
// passender Checkpoint ist ein Policy-Verstoß; er wird verworfen und die Kette
// ab Genesis neu geprüft.
//
// Jede Zeile wird per Compare-and-set fortgeschrieben; jeder Schreibvorgang
// setzt `verified_at` streng später als die ersetzte Zeile. Scheitert ein
// Compare-and-set, ist das nur dann ein paralleler Lauf, wenn die vorgefundene
// Zeile authentisch, später geschrieben und zur Kette passend ist: Der Lauf
// übernimmt sie und prüft weiter. Eine gelöschte, verfälschte oder durch einen
// älteren Stand ersetzte Zeile ist ein Policy-Verstoß. Kein Lauf wird
// übersprungen. verifyChain selbst (CLI, Prüfer-Link, Backup-Drill) bleibt die
// checkpointfreie Vollprüfung.
// =============================================================================

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { anchorGenesisHash } from './anchor';
import { canonicalJson } from './canonical-json';
import {
  DEFAULT_SEGMENT_LIMITS,
  applyUnanchoredAgePolicy,
  createVerificationResult,
  genesisCursor,
  genesisHash,
  recomputeStoredRow,
  type ChainCursor,
  type EvidenceService,
  type EvidenceTx,
  type IncrementalVerificationInfo,
  type SegmentBounds,
  type SegmentLimits,
  type SegmentOutcome,
  type SegmentSealBreak,
  type VerificationResult,
  type VerifyChainOptions,
} from './service';

export type VerifyCheckpointKind = 'INCREMENTAL' | 'FULL' | 'FULL_TARGET';

const ALL_KINDS: VerifyCheckpointKind[] = ['INCREMENTAL', 'FULL', 'FULL_TARGET'];
const FULL_KINDS: VerifyCheckpointKind[] = ['FULL', 'FULL_TARGET'];

/** Höchstens so viele Siegel- bzw. Ankerbefunde je Checkpoint einzeln speichern. */
export const MAX_STORED_FINDINGS = 1_000;
/** Zulässige Uhrabweichung zwischen Worker-Instanzen für Checkpoint-Zeitstempel. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
/**
 * Eine Vollprüfung ohne Fortschritt seit dieser Zeit stockt: Policy-Verstoß
 * „Vollprüfung stockt“, danach beginnt sie neu.
 */
export const FULL_SWEEP_STALE_AFTER_MS = 3 * 24 * 60 * 60_000;
/**
 * Läuft keine Vollprüfung und liegt die letzte abgeschlossene mehr als dieses
 * Vielfache des Intervalls zurück, ist sie überfällig (Policy-Verstoß). Eine
 * fortschreitende Vollprüfung gilt nie als überfällig, auch wenn sie bei großen
 * Ketten länger dauert; bleibt ihr Fortschritt aus, meldet der Lauf, dass sie
 * stockt.
 */
export const FULL_VERIFY_OVERDUE_FACTOR = 3;
const DAY_MS = 24 * 60 * 60_000;
const MAC_CONTEXT = 'taxtronik-audit-verify-checkpoint-v1\n';

export interface StoredSealFinding {
  id: string;
  date: string;
  top: string;
  reason: string;
}

export interface StoredAnchorFinding {
  id: string;
  top: string;
  reason: string;
}

/** Siegel-/Ankerbefunde bis zur Position eines Checkpoints, je Art nach ID sortiert. */
export interface CheckpointFindings {
  seals: StoredSealFinding[];
  anchors: StoredAnchorFinding[];
  /** Über MAX_STORED_FINDINGS hinaus nur gezählte Befunde (höchste IDs). */
  omittedSeals: number;
  omittedAnchors: number;
}

export interface StoredVerifyCheckpoint {
  kind: VerifyCheckpointKind;
  cursor: ChainCursor;
  findings: CheckpointFindings;
  /**
   * FULL/FULL_TARGET: Kennung ihrer Vollprüfung. INCREMENTAL: Kennung der
   * laufenden Vollprüfung (null = keine läuft).
   */
  sweepId: string | null;
  startedAt: Date;
  /** Zeitpunkt des letzten Schreibvorgangs; steigt mit jedem Schreiben streng. */
  verifiedAt: Date;
  completedAt: Date | null;
  mac: Buffer;
}

type CheckpointState = Omit<StoredVerifyCheckpoint, 'mac'>;

export type LoadedVerifyCheckpoint =
  | { status: 'missing' }
  | { status: 'invalid'; problem: string }
  | { status: 'ok'; checkpoint: StoredVerifyCheckpoint };

/** Führt einen Abschnitt in einer eigenen Transaktion aus (Worker: Owner-Client). */
export type VerifyTxRunner = <T>(work: (tx: EvidenceTx) => Promise<T>) => Promise<T>;

export interface CheckpointedVerifyOptions extends VerifyChainOptions {
  /** HMAC-Schlüssel der Checkpoints (Worker: deriveAuditCheckpointMacKey()). */
  checkpointKey: Buffer;
  /** Abstand, nach dem eine erneute Vollprüfung ab Genesis fällig ist. */
  fullVerifyIntervalMs: number;
  /** Zeitbudget je Lauf für die fortsetzbare Vollprüfung. */
  fullVerifyBudgetMs: number;
  /** Vollprüfung jetzt beginnen, falls keine läuft (manueller Prüflauf). */
  forceFullVerify?: boolean;
  segmentLimits?: SegmentLimits;
  /** Uhr für persistierte Zeitpunkte und Fälligkeit (Tests). */
  now?: () => Date;
}

interface CheckpointRow {
  audit_id: bigint;
  audit_hash: Buffer;
  audit_count: bigint;
  seal_id: bigint;
  seals_checked: bigint;
  seals_trust_anchored: bigint | null;
  anchor_id: bigint;
  anchor_hash: Buffer;
  anchor_top_audit_id: bigint;
  anchors_checked: bigint;
  anchors_trust_anchored: bigint;
  started_at: Date;
  verified_at: Date;
  completed_at: Date | null;
  findings: unknown;
  sweep_id: string | null;
  mac: Buffer;
}

interface BoundsSnapshot {
  maxSealId: bigint;
  lastAnchorId: bigint | null;
  lastAnchorTopAuditId: bigint | null;
}

interface RunContext {
  tenantId: string;
  key: Buffer;
  limits: SegmentLimits;
  clock: () => Date;
  /** Laufbeginn: Eine erst danach angelegte Zeile stammt von einem parallelen Lauf. */
  runStartedAt: Date;
  info: IncrementalVerificationInfo;
  result: VerificationResult;
  /** In diesem Lauf wurde ein Checkpoint als Manipulationsverdacht verworfen. */
  discarded: boolean;
  /** false: Nach einem erneuten Eingriff während des Laufs nur noch im Speicher prüfen. */
  persist: boolean;
  /** Letzter Fortschritt (verified_at des FULL-Stands) der laufenden Vollprüfung. */
  sweepProgressAt: Date | null;
  /** Ein paralleler Lauf hat die Vollprüfung übernommen (nichts zur Fälligkeit melden). */
  sweepElsewhere: boolean;
}

/** Prüfstand der Zuwachsprüfung während eines Laufs. */
interface Line {
  /** Gehaltene INCREMENTAL-Zeile (Compare-and-set); null = keine geschrieben. */
  held: StoredVerifyCheckpoint | null;
  cursor: ChainCursor;
  findings: CheckpointFindings;
  /** Die Linie ist lückenlos ab Genesis geprüft, sobald sie das Kettenende erreicht. */
  fromGenesis: boolean;
  /** Der Walk dieses Laufs begann bei Genesis (deckt die Kette bis `cursor` ab). */
  walkedFromGenesis: boolean;
}

/** Ergebnis der Zuwachsprüfung. */
interface Frontier {
  /** Gehaltener INCREMENTAL-Stand nach diesem Lauf (null: keiner gespeichert). */
  checkpoint: StoredVerifyCheckpoint | null;
  /** Erreichte Kettenspitze bzw. letzte intakte Zeile vor einem Bruch. */
  cursor: ChainCursor;
  /** Siegel-/Ankerbefunde bis `cursor`. */
  findings: CheckpointFindings;
  /** Siegel mit Spitze jenseits des Kettenendes; je Lauf neu ermittelt, nie gezählt. */
  danglingSeals: SegmentSealBreak[];
  /** Hash-/Vorgängerbruch (hat Vorrang vor Siegel-/Ankerbefunden). */
  failure: SegmentOutcome | null;
  walkedFromGenesis: boolean;
}

interface Sweep {
  full: StoredVerifyCheckpoint;
  target: StoredVerifyCheckpoint;
}

/** Einordnung einer vorgefundenen Zeile nach gescheitertem Compare-and-set. */
type AdoptVerdict =
  /** Paralleler Lauf: dessen Zeile übernehmen und weiterprüfen. */
  | { kind: 'adopt'; checkpoint: StoredVerifyCheckpoint }
  /** Eingriff in die Checkpoints (Manipulationsverdacht). */
  | { kind: 'problem'; problem: string };

/** Wie AdoptVerdict; `stop`: ein paralleler Lauf führt die Vollprüfung weiter. */
type ConflictVerdict = AdoptVerdict | { kind: 'stop' };

/**
 * Prüft die Kette ab dem Prüf-Checkpoint und setzt eine fällige Vollprüfung
 * fort. Liefert ein Ergebnis mit derselben Bedeutung wie verifyChain: Zähler
 * kumuliert ab Genesis, `lastAuditId` = geprüfte Kettenspitze, Brüche und
 * Befunde wie dort.
 */
export async function verifyChainWithCheckpoints(
  service: EvidenceService,
  runTx: VerifyTxRunner,
  tenantId: string,
  opts: CheckpointedVerifyOptions,
): Promise<VerificationResult> {
  if (opts.checkpointKey.length < 32) {
    throw new RangeError('Der Checkpoint-Schlüssel braucht mindestens 32 Byte.');
  }
  const result = createVerificationResult(service.tsaMode, opts);
  const clock = opts.now ?? (() => new Date());
  const ctx: RunContext = {
    tenantId,
    key: opts.checkpointKey,
    limits: opts.segmentLimits ?? DEFAULT_SEGMENT_LIMITS,
    clock,
    runStartedAt: clock(),
    info: {
      mode: 'incremental',
      startAuditId: null,
      rowsHashed: 0,
      lastFullVerifiedAt: null,
      fullVerification: null,
    },
    result,
    discarded: false,
    persist: true,
    sweepProgressAt: null,
    sweepElsewhere: false,
  };
  result.incremental = ctx.info;

  // Siegel-/Ankergrenzen VOR jedem Walk: Diese Elemente binden nur Einträge,
  // die bereits committet waren und deshalb vom Walk gelesen werden.
  const snapshot = await runTx((tx) => loadBoundsSnapshot(tx, tenantId));
  result.lastAnchorId = snapshot.lastAnchorId;
  result.lastAnchoredAuditId = snapshot.lastAnchorTopAuditId;

  const stored = await loadIncrementalOrDiscard(runTx, ctx);
  ctx.info.startAuditId = stored ? stored.cursor.auditId : null;
  ctx.info.lastFullVerifiedAt = stored?.completedAt ?? null;

  const frontier = await advanceIncremental(service, runTx, stored, snapshot, ctx);
  copyCursorCounts(result, frontier.cursor);
  if (frontier.failure) applyChainBreak(result, frontier.failure);

  const sweepFindings = await runFullVerificationIfDue(service, runTx, frontier, ctx, opts);

  if (!result.firstBreak) {
    // Wie verifyChain: Auch ein Siegel ohne Spitze zählt und ist ein Befund.
    result.sealsChecked += frontier.danglingSeals.length;
    reportFindings(result, sweepFindings ?? frontier.findings, frontier.danglingSeals);
  }
  applyOverduePolicy(ctx, opts);
  await runTx((tx) => fillUnanchoredSummary(tx, tenantId, result));
  if (!result.firstBreak) applyUnanchoredAgePolicy(result, opts.maxUnanchoredAgeMs);
  result.ok =
    !result.firstBreak &&
    result.sealBreaks.length === 0 &&
    result.anchorBreaks.length === 0 &&
    result.policyBreaks.length === 0;
  return result;
}

/**
 * Lädt den INCREMENTAL-Checkpoint. Ist er nicht authentisch oder passt er
 * nicht zur gespeicherten Kette, wird das als Policy-Verstoß gemeldet, alle
 * Checkpoints werden verworfen und die Prüfung beginnt bei Genesis.
 */
async function loadIncrementalOrDiscard(
  runTx: VerifyTxRunner,
  ctx: RunContext,
): Promise<StoredVerifyCheckpoint | null> {
  const loaded = await runTx((tx) =>
    loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'INCREMENTAL', ctx.clock()),
  );
  if (loaded.status === 'missing') {
    // Abschluss, Abbruch und Verwerfen löschen den Vollprüfungsstand stets mit:
    // Ein Vollprüfungsstand ohne Prüf-Checkpoint ist ein Eingriff.
    const orphaned = await runTx((tx) => hasVerifyCheckpoints(tx, ctx.tenantId, FULL_KINDS));
    if (orphaned) {
      await discardCheckpoints(
        runTx,
        ctx,
        'Prüf-Checkpoint fehlt, obwohl ein Stand der Vollprüfung vorliegt',
      );
    }
    return null;
  }
  if (loaded.status === 'invalid') {
    await discardCheckpoints(
      runTx,
      ctx,
      `Prüf-Checkpoint ist nicht authentisch: ${loaded.problem}`,
    );
    return null;
  }
  const cursor = loaded.checkpoint.cursor;
  const problem = await runTx((tx) => checkpointIntegrityProblem(tx, ctx.tenantId, cursor));
  if (!problem) return loaded.checkpoint;
  await discardCheckpoints(
    runTx,
    ctx,
    `Prüf-Checkpoint passt nicht zur gespeicherten Kette: ${problem}`,
  );
  return null;
}

/**
 * Integritätsbruch der Checkpoints: Policy-Verstoß, alle Checkpoints verwerfen,
 * die Zuwachsprüfung beginnt bei Genesis neu. Ein erneuter Eingriff im selben
 * Lauf schaltet auf eine reine Speicherprüfung um, damit der Lauf trotzdem bis
 * zum Kettenende prüft und alle Befunde meldet.
 */
async function discardCheckpoints(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  problem: string,
): Promise<void> {
  ctx.result.policyBreaks.push(
    `${problem} (Manipulationsverdacht). Checkpoint verworfen; Kette ab Genesis neu geprüft.`,
  );
  if (ctx.discarded) ctx.persist = false;
  ctx.discarded = true;
  ctx.info.startAuditId = null;
  ctx.info.lastFullVerifiedAt = null;
  ctx.info.fullVerification = null;
  await runTx((tx) => deleteVerifyCheckpoints(tx, ctx.tenantId, ALL_KINDS));
}

function genesisLine(ctx: RunContext): Line {
  return {
    held: null,
    cursor: genesisCursor(ctx.tenantId),
    findings: emptyFindings(),
    fromGenesis: true,
    walkedFromGenesis: true,
  };
}

/**
 * Zuwachsprüfung bis zum Kettenende; persistiert nach jedem Abschnitt ohne
 * Kettenbruch Prüfstand und Befunde (Compare-and-set über die Prüfsumme).
 */
async function advanceIncremental(
  service: EvidenceService,
  runTx: VerifyTxRunner,
  stored: StoredVerifyCheckpoint | null,
  snapshot: BoundsSnapshot,
  ctx: RunContext,
): Promise<Frontier> {
  let line: Line = stored
    ? {
        held: stored,
        cursor: stored.cursor,
        findings: stored.findings,
        // Unterbrochener Genesis-Walk: Die Linie wird am Kettenende abgeschlossen.
        fromGenesis: stored.completedAt === null,
        walkedFromGenesis: false,
      }
    : genesisLine(ctx);
  let restartedFromGenesis = false;
  for (;;) {
    const start = line;
    const bounds = boundsFor(snapshot, start.cursor);
    const step = await runTx(async (tx) => {
      const outcome = await service.verifyChainSegment(
        tx,
        ctx.tenantId,
        start.cursor,
        bounds,
        ctx.limits,
      );
      if (outcome.firstBreak) return { outcome, findings: start.findings, saved: undefined };
      const findings = mergeFindings(start.findings, outcome);
      if (!ctx.persist) return { outcome, findings, saved: undefined };
      const saved = start.held
        ? await updateCheckpoint(tx, ctx, start.held, { cursor: outcome.cursor, findings })
        : await insertCheckpoint(tx, ctx, newIncremental(ctx, outcome.cursor, findings));
      return { outcome, findings, saved };
    });
    ctx.info.rowsHashed += step.outcome.rowsChecked;
    const failure = step.outcome.firstBreak ? step.outcome : null;
    if (failure) {
      if (failure.firstBreak!.auditId <= start.cursor.auditId && !restartedFromGenesis) {
        // Ein nachträglich angelegtes Siegel/ein Anker legte eine manipulierte
        // Zeile UNTERHALB des Checkpoints offen. Wie verifyChain den ersten Bruch
        // der Gesamtkette melden: Checkpoints verwerfen, ab Genesis neu prüfen.
        restartedFromGenesis = true;
        if (ctx.persist) {
          await runTx((tx) => deleteVerifyCheckpoints(tx, ctx.tenantId, ALL_KINDS));
        }
        ctx.info.startAuditId = null;
        ctx.info.lastFullVerifiedAt = null;
        line = genesisLine(ctx);
        continue;
      }
      return {
        checkpoint: start.held,
        cursor: failure.cursor,
        findings: start.findings,
        danglingSeals: [],
        failure,
        walkedFromGenesis: start.walkedFromGenesis,
      };
    }
    if (step.saved === null) {
      line = await resolveIncrementalConflict(runTx, ctx, start.held);
      continue;
    }
    line = {
      ...start,
      held: step.saved ?? start.held,
      cursor: step.outcome.cursor,
      findings: step.findings,
    };
    if (!step.outcome.complete) continue;

    if (line.fromGenesis) {
      const completed = await completeLine(runTx, ctx, line);
      if (!completed) {
        line = await resolveIncrementalConflict(runTx, ctx, line.held);
        continue;
      }
      line = completed;
    }
    return {
      checkpoint: line.held,
      cursor: line.cursor,
      findings: line.findings,
      danglingSeals: step.outcome.danglingSeals,
      failure: null,
      walkedFromGenesis: line.walkedFromGenesis,
    };
  }
}

function newIncremental(
  ctx: RunContext,
  cursor: ChainCursor,
  findings: CheckpointFindings,
): CheckpointState {
  const now = ctx.clock();
  return {
    kind: 'INCREMENTAL',
    cursor,
    findings,
    sweepId: null,
    startedAt: now,
    verifiedAt: now,
    completedAt: null,
  };
}

/** Kettenende einer ab Genesis geprüften Linie: Abschluss der Vollprüfung festhalten. */
async function completeLine(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  line: Line,
): Promise<Line | null> {
  const completedAt = ctx.clock();
  let done = line;
  if (ctx.persist && line.held) {
    const held = line.held;
    const completed = await runTx((tx) => updateCheckpoint(tx, ctx, held, { completedAt }));
    if (!completed) return null;
    done = { ...line, held: completed, fromGenesis: false };
  }
  ctx.info.mode = 'full';
  ctx.info.lastFullVerifiedAt = completedAt;
  return done;
}

/**
 * Compare-and-set der Zuwachsprüfung gescheitert: Die Zeile eines parallelen
 * Laufs übernehmen, sonst Integritätsbruch und Neuprüfung ab Genesis.
 */
async function resolveIncrementalConflict(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  held: StoredVerifyCheckpoint | null,
): Promise<Line> {
  const latest = await runTx((tx) =>
    loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'INCREMENTAL', ctx.clock()),
  );
  let verdict: AdoptVerdict;
  if (latest.status === 'missing') {
    verdict = problemVerdict('Prüf-Checkpoint wurde während des Prüflaufs gelöscht');
  } else if (latest.status === 'invalid') {
    verdict = problemVerdict(
      `Prüf-Checkpoint wurde während des Prüflaufs verändert: ${latest.problem}`,
    );
  } else {
    verdict = await adoptIfNewer(runTx, ctx, latest.checkpoint, held, 'Prüf-Checkpoint');
  }
  if (verdict.kind === 'adopt') {
    const adopted = verdict.checkpoint;
    if (adopted.completedAt) ctx.info.lastFullVerifiedAt = adopted.completedAt;
    return {
      held: adopted,
      cursor: adopted.cursor,
      findings: adopted.findings,
      fromGenesis: adopted.completedAt === null,
      walkedFromGenesis: false,
    };
  }
  await discardCheckpoints(runTx, ctx, verdict.problem);
  return genesisLine(ctx);
}

function problemVerdict(problem: string): { kind: 'problem'; problem: string } {
  return { kind: 'problem', problem };
}

/**
 * Übernimmt die vorgefundene Zeile eines parallelen Laufs: authentisch (vom
 * Aufrufer geprüft), später geschrieben als der gehaltene Stand und passend
 * zur gespeicherten Kette. Eine wieder eingespielte ältere Zeile ist nie
 * später geschrieben, weil jeder Schreibvorgang `verified_at` streng erhöht.
 */
async function adoptIfNewer(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  competitor: StoredVerifyCheckpoint,
  held: StoredVerifyCheckpoint | null,
  label: string,
): Promise<AdoptVerdict> {
  const later = held
    ? competitor.verifiedAt.getTime() > held.verifiedAt.getTime()
    : // Ohne gehaltene Zeile: erst nach Beginn dieses Laufs angelegt.
      competitor.startedAt.getTime() >= ctx.runStartedAt.getTime() - CLOCK_SKEW_TOLERANCE_MS;
  if (!later) {
    return problemVerdict(`${label} wurde während des Prüflaufs durch einen älteren Stand ersetzt`);
  }
  const problem = await runTx((tx) =>
    checkpointIntegrityProblem(tx, ctx.tenantId, competitor.cursor),
  );
  if (problem) return problemVerdict(`${label} passt nicht zur gespeicherten Kette: ${problem}`);
  return { kind: 'adopt', checkpoint: competitor };
}

/**
 * Setzt eine laufende Vollprüfung fort oder beginnt eine fällige. Sie endet am
 * eingefrorenen Ziel (FULL_TARGET) und muss dessen Stand exakt bestätigen.
 * Liefert die zu meldenden Befunde, wenn sie von denen des INCREMENTAL-Stands
 * abweichen (laufende Vollprüfung mit neuen Befunden, geändertes Prüfergebnis).
 */
async function runFullVerificationIfDue(
  service: EvidenceService,
  runTx: VerifyTxRunner,
  frontier: Frontier,
  ctx: RunContext,
  opts: CheckpointedVerifyOptions,
): Promise<CheckpointFindings | null> {
  // Ein Walk ab Genesis in diesem Lauf IST die Vollprüfung bis zur Spitze.
  if (ctx.info.mode === 'full' || frontier.walkedFromGenesis || !frontier.checkpoint) return null;
  if (!ctx.persist) return null;
  let incremental = frontier.checkpoint;
  const now = ctx.clock();
  const [running, frozen] = await runTx(async (tx) => [
    await loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'FULL', now),
    await loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'FULL_TARGET', now),
  ]);
  const pairProblem = sweepPairProblem(incremental.sweepId, running, frozen);
  if (pairProblem) {
    await failAndReset(runTx, ctx, pairProblem);
    return null;
  }
  let sweep: Sweep | null =
    running.status === 'ok' && frozen.status === 'ok'
      ? { full: running.checkpoint, target: frozen.checkpoint }
      : null;
  if (sweep && now.getTime() - sweep.full.verifiedAt.getTime() > FULL_SWEEP_STALE_AFTER_MS) {
    // Seit Tagen kein Fortschritt: „Vollprüfung stockt“ melden, die Vollprüfung
    // aufgeben und, da fällig, neu beginnen.
    reportStalledSweep(ctx, sweep.full.startedAt, sweep.full.verifiedAt);
    const held = incremental;
    const cleared = await runTx(async (tx) => {
      const saved = await updateCheckpoint(tx, ctx, held, { sweepId: null });
      if (saved) await deleteVerifyCheckpoints(tx, ctx.tenantId, FULL_KINDS);
      return saved;
    });
    if (!cleared) return settleSweepConflict(runTx, ctx, held);
    incremental = cleared;
    sweep = null;
  }
  const lastFull = ctx.info.lastFullVerifiedAt;
  const due =
    sweep !== null ||
    opts.forceFullVerify === true ||
    lastFull === null ||
    now.getTime() - lastFull.getTime() >= opts.fullVerifyIntervalMs;
  if (!due) return null;

  if (sweep) {
    const { full, target } = sweep;
    const problem = await runTx(
      async (tx) =>
        (await checkpointIntegrityProblem(tx, ctx.tenantId, full.cursor)) ??
        (await checkpointIntegrityProblem(tx, ctx.tenantId, target.cursor)),
    );
    if (problem) {
      await failAndReset(runTx, ctx, `Stand der Vollprüfung: ${problem}`);
      return null;
    }
  } else {
    const started = await startSweep(runTx, ctx, incremental, now);
    if (!started) return settleSweepConflict(runTx, ctx, incremental);
    incremental = started.incremental;
    sweep = started.sweep;
  }
  return continueSweep(service, runTx, sweep, incremental, frontier, ctx, opts);
}

/**
 * FULL und FULL_TARGET gehören genau zur im Checkpoint gebundenen laufenden
 * Vollprüfung. Abschluss, Abbruch und Start schreiben beide Zeilen in derselben
 * Transaktion wie die Bindung; jede Abweichung ist ein Eingriff.
 */
function sweepPairProblem(
  activeSweepId: string | null,
  running: LoadedVerifyCheckpoint,
  frozen: LoadedVerifyCheckpoint,
): string | null {
  for (const loaded of [running, frozen]) {
    if (loaded.status === 'invalid') {
      return `Stand der Vollprüfung ist nicht authentisch: ${loaded.problem}`;
    }
  }
  if (activeSweepId === null) {
    return running.status === 'ok' || frozen.status === 'ok'
      ? 'Stand einer nicht laufenden Vollprüfung vorgefunden (wieder eingespielt)'
      : null;
  }
  if (running.status !== 'ok' || frozen.status !== 'ok') {
    return 'Stand der laufenden Vollprüfung fehlt';
  }
  if (running.checkpoint.sweepId !== activeSweepId || frozen.checkpoint.sweepId !== activeSweepId) {
    return 'Stand der Vollprüfung gehört nicht zur laufenden Vollprüfung';
  }
  return null;
}

/**
 * Beginnt eine Vollprüfung: bindet ihre Kennung im INCREMENTAL-Checkpoint und
 * legt Ziel und Fortschritt in derselben Transaktion an. null: Compare-and-set
 * auf den Checkpoint gescheitert.
 */
async function startSweep(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  incremental: StoredVerifyCheckpoint,
  startedAt: Date,
): Promise<{ incremental: StoredVerifyCheckpoint; sweep: Sweep } | null> {
  const sweepId = randomUUID();
  const base = { sweepId, startedAt, verifiedAt: startedAt, completedAt: null };
  return runTx(async (tx) => {
    const bound = await updateCheckpoint(tx, ctx, incremental, { sweepId });
    if (!bound) return null;
    await deleteVerifyCheckpoints(tx, ctx.tenantId, FULL_KINDS);
    const target = await insertCheckpoint(tx, ctx, {
      ...base,
      kind: 'FULL_TARGET',
      cursor: incremental.cursor,
      findings: incremental.findings,
    });
    const full = await insertCheckpoint(tx, ctx, {
      ...base,
      kind: 'FULL',
      cursor: genesisCursor(ctx.tenantId, incremental.cursor.sealId),
      findings: emptyFindings(),
    });
    if (!target || !full) {
      // Nach dem Löschen in dieser Transaktion kollidiert nur ein Eingriff;
      // der Fehler rollt auch die Bindung zurück und alarmiert.
      throw new Error(
        'Stand der Vollprüfung wurde beim Start parallel angelegt (Manipulationsverdacht).',
      );
    }
    return { incremental: bound, sweep: { full, target } };
  });
}

async function continueSweep(
  service: EvidenceService,
  runTx: VerifyTxRunner,
  sweep: Sweep,
  incremental: StoredVerifyCheckpoint,
  frontier: Frontier,
  ctx: RunContext,
  opts: CheckpointedVerifyOptions,
): Promise<CheckpointFindings | null> {
  const target = sweep.target;
  const bounds: SegmentBounds = {
    maxAuditId: target.cursor.auditId,
    maxSealId: target.cursor.sealId,
    maxAnchorId: target.cursor.anchorId,
  };
  const progress = {
    startedAt: sweep.full.startedAt,
    auditId: sweep.full.cursor.auditId,
    targetAuditId: target.cursor.auditId,
  };
  ctx.info.fullVerification = progress;
  ctx.sweepProgressAt = sweep.full.verifiedAt;
  const deadline = Date.now() + opts.fullVerifyBudgetMs;
  let full = sweep.full;
  for (;;) {
    const current = full;
    const step = await runTx(async (tx) => {
      const outcome = await service.verifyChainSegment(
        tx,
        ctx.tenantId,
        current.cursor,
        bounds,
        ctx.limits,
      );
      if (outcome.firstBreak) return { outcome, saved: null };
      const saved = await updateCheckpoint(tx, ctx, current, {
        cursor: outcome.cursor,
        findings: mergeFindings(current.findings, outcome),
      });
      return { outcome, saved };
    });
    ctx.info.rowsHashed += step.outcome.rowsChecked;
    if (step.outcome.firstBreak) {
      // Wie verifyChain: Der erste Bruch der Gesamtkette hat Vorrang.
      applyChainBreak(ctx.result, step.outcome);
      ctx.info.fullVerification = null;
      await runTx((tx) => deleteVerifyCheckpoints(tx, ctx.tenantId, ALL_KINDS));
      return null;
    }
    if (!step.saved) {
      const verdict = await classifySweepConflict(runTx, ctx, incremental, current);
      if (verdict.kind === 'problem') {
        await failAndReset(runTx, ctx, verdict.problem);
        return null;
      }
      if (verdict.kind === 'stop') return unionFindings(frontier.findings, current.findings);
      full = verdict.checkpoint;
      progress.auditId = full.cursor.auditId;
      ctx.sweepProgressAt = full.verifiedAt;
      continue;
    }
    full = step.saved;
    progress.auditId = full.cursor.auditId;
    ctx.sweepProgressAt = full.verifiedAt;

    if (step.outcome.complete) {
      return completeSweep(runTx, ctx, full, target, incremental, frontier);
    }
    if (Date.now() >= deadline) {
      // Fortsetzung im nächsten Lauf; neue Befunde der Vollprüfung schon melden.
      return unionFindings(frontier.findings, full.findings);
    }
  }
}

/**
 * Am Ziel: Positionen müssen exakt übereinstimmen (sonst Manipulationsverdacht),
 * und nur die im Checkpoint gebundene, nach der letzten abgeschlossenen
 * Vollprüfung begonnene Vollprüfung schließt ab. Weicht nur das Prüfergebnis
 * bereits verarbeiteter Siegel/Anker ab (z. B. geänderter Trust-Store), werden
 * die neuen Befunde gemeldet und der Checkpoint auf den Stand der Vollprüfung
 * gesetzt: Der nächste Lauf prüft ab dort bis zur Spitze erneut und schließt
 * die Prüfung ab Genesis ab.
 */
async function completeSweep(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  full: StoredVerifyCheckpoint,
  target: StoredVerifyCheckpoint,
  incremental: StoredVerifyCheckpoint,
  frontier: Frontier,
): Promise<CheckpointFindings | null> {
  const mismatch = cursorMismatch(full.cursor, target.cursor);
  if (mismatch) {
    await failAndReset(runTx, ctx, `Vollprüfung bestätigt den Prüf-Checkpoint nicht (${mismatch})`);
    return null;
  }
  const lastCompleted = incremental.completedAt;
  if (
    full.sweepId !== incremental.sweepId ||
    (lastCompleted !== null && full.startedAt.getTime() <= lastCompleted.getTime())
  ) {
    await failAndReset(
      runTx,
      ctx,
      'Stand der Vollprüfung stammt nicht aus der laufenden Vollprüfung',
    );
    return null;
  }
  const completedAt = ctx.clock();
  const changed = outcomeChanged(full, target);
  const saved = await runTx(async (tx) => {
    const next = changed
      ? await updateCheckpoint(tx, ctx, incremental, {
          cursor: full.cursor,
          findings: full.findings,
          startedAt: full.startedAt,
          completedAt: null,
          sweepId: null,
        })
      : await updateCheckpoint(tx, ctx, incremental, { completedAt, sweepId: null });
    if (next) await deleteVerifyCheckpoints(tx, ctx.tenantId, FULL_KINDS);
    return next;
  });
  if (!saved) {
    const verdict = await classifySweepConflict(runTx, ctx, incremental, null);
    if (verdict.kind === 'problem') {
      await failAndReset(runTx, ctx, verdict.problem);
      return null;
    }
    return unionFindings(frontier.findings, full.findings);
  }
  ctx.info.fullVerification = null;
  ctx.info.lastFullVerifiedAt = completedAt;
  if (changed) {
    return unionFindings(uncoveredFindings(frontier.findings, target.cursor), full.findings);
  }
  ctx.info.mode = 'full';
  return null;
}

/**
 * Compare-and-set auf den Checkpoint außerhalb eines Vollprüfungsabschnitts
 * gescheitert: Ein paralleler Lauf führt die Vollprüfung weiter, sonst Befund.
 */
async function settleSweepConflict(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  incremental: StoredVerifyCheckpoint,
): Promise<null> {
  const verdict = await classifySweepConflict(runTx, ctx, incremental, null);
  if (verdict.kind === 'problem') await failAndReset(runTx, ctx, verdict.problem);
  else ctx.sweepElsewhere = true;
  return null;
}

/**
 * Ordnet einen gescheiterten Compare-and-set der Vollprüfung ein. Hat ein
 * paralleler Lauf den Checkpoint fortgeschrieben (Zuwachs, Start, Abschluss
 * oder Abbruch einer Vollprüfung), führt er die Vollprüfung weiter. Ist der
 * Checkpoint unverändert, muss der Fortschritt der Vollprüfung von einem
 * parallelen Lauf derselben Vollprüfung stammen; er wird übernommen.
 */
async function classifySweepConflict(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  incremental: StoredVerifyCheckpoint,
  full: StoredVerifyCheckpoint | null,
): Promise<ConflictVerdict> {
  const now = ctx.clock();
  const [latestIncremental, latestFull] = await runTx(async (tx) => [
    await loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'INCREMENTAL', now),
    await loadVerifyCheckpoint(tx, ctx.key, ctx.tenantId, 'FULL', now),
  ]);
  if (latestIncremental.status === 'missing') {
    return problemVerdict('Prüf-Checkpoint wurde während der Vollprüfung gelöscht');
  }
  if (latestIncremental.status === 'invalid') {
    return problemVerdict(
      `Prüf-Checkpoint wurde während der Vollprüfung verändert: ${latestIncremental.problem}`,
    );
  }
  if (!latestIncremental.checkpoint.mac.equals(incremental.mac)) {
    const verdict = await adoptIfNewer(
      runTx,
      ctx,
      latestIncremental.checkpoint,
      incremental,
      'Prüf-Checkpoint',
    );
    return verdict.kind === 'adopt' ? { kind: 'stop' } : verdict;
  }
  if (!full) return problemVerdict('Prüf-Checkpoint wurde während der Vollprüfung verändert');
  if (latestFull.status === 'missing') {
    return problemVerdict('Stand der laufenden Vollprüfung wurde während des Prüflaufs gelöscht');
  }
  if (latestFull.status === 'invalid') {
    return problemVerdict(
      `Stand der Vollprüfung wurde während des Prüflaufs verändert: ${latestFull.problem}`,
    );
  }
  if (latestFull.checkpoint.sweepId !== full.sweepId) {
    return problemVerdict('Stand der Vollprüfung gehört nicht zur laufenden Vollprüfung');
  }
  return adoptIfNewer(runTx, ctx, latestFull.checkpoint, full, 'Stand der Vollprüfung');
}

async function failAndReset(
  runTx: VerifyTxRunner,
  ctx: RunContext,
  problem: string,
): Promise<void> {
  ctx.result.policyBreaks.push(
    `${problem} (Manipulationsverdacht). Prüf-Checkpoints verworfen; ` +
      'der nächste Lauf prüft die Kette ab Genesis.',
  );
  ctx.info.fullVerification = null;
  ctx.discarded = true;
  await runTx((tx) => deleteVerifyCheckpoints(tx, ctx.tenantId, ALL_KINDS));
}

/**
 * Fälligkeit nach dem Lauf: Eine laufende Vollprüfung ist nur ein Befund, wenn
 * sie seit mehr als drei Tagen nicht fortschreitet („Vollprüfung stockt“); ohne
 * laufende Vollprüfung ist eine zu alte letzte abgeschlossene „überfällig“.
 */
function applyOverduePolicy(ctx: RunContext, opts: CheckpointedVerifyOptions): void {
  if (ctx.sweepElsewhere) return;
  const now = ctx.clock().getTime();
  const running = ctx.info.fullVerification;
  if (running) {
    const progressAt = ctx.sweepProgressAt;
    if (progressAt && now - progressAt.getTime() > FULL_SWEEP_STALE_AFTER_MS) {
      reportStalledSweep(ctx, running.startedAt, progressAt);
    }
    return;
  }
  const last = ctx.info.lastFullVerifiedAt;
  if (!last) return;
  const limitMs = FULL_VERIFY_OVERDUE_FACTOR * opts.fullVerifyIntervalMs;
  if (now - last.getTime() <= limitMs) return;
  ctx.result.policyBreaks.push(
    'Vollprüfung überfällig: Die letzte abgeschlossene Vollprüfung ab Genesis ' +
      `(${last.toISOString()}) liegt mehr als ${Math.round(limitMs / DAY_MS)} Tage zurück.`,
  );
}

/** Policy-Verstoß: Die laufende Vollprüfung schreitet seit mehr als drei Tagen nicht fort. */
function reportStalledSweep(ctx: RunContext, startedAt: Date, progressAt: Date): void {
  ctx.result.policyBreaks.push(
    `Vollprüfung stockt: Die am ${startedAt.toISOString()} begonnene Vollprüfung ab ` +
      `Genesis hat seit ${progressAt.toISOString()} keinen Fortschritt gemacht ` +
      `(mehr als ${Math.round(FULL_SWEEP_STALE_AFTER_MS / DAY_MS)} Tage).`,
  );
}

/** Übernimmt einen Hash-/Vorgängerbruch wie verifyChain (erster Bruch gewinnt). */
function applyChainBreak(result: VerificationResult, failure: SegmentOutcome): void {
  if (!failure.firstBreak) return;
  if (result.firstBreak && result.firstBreak.auditId <= failure.firstBreak.auditId) return;
  // Wie verifyChain: geprüft bis zur letzten intakten Zeile vor dem ersten
  // Kettenbruch; Siegel und Anker werden dann nicht mehr bewertet.
  result.firstBreak = failure.firstBreak;
  result.checked = failure.cursor.auditCount;
  result.lastAuditId = failure.cursor.auditId > BigInt(0) ? failure.cursor.auditId : null;
  result.sealsChecked = 0;
  result.sealsTrustAnchored = undefined;
  result.sealBreaks = [];
  result.anchorsChecked = 0;
  result.anchorsTrustAnchored = 0;
  result.anchorBreaks = [];
}

function copyCursorCounts(result: VerificationResult, cursor: ChainCursor): void {
  result.checked = cursor.auditCount;
  result.lastAuditId = cursor.auditId > BigInt(0) ? cursor.auditId : null;
  result.sealsChecked = cursor.sealsChecked;
  result.sealsTrustAnchored = cursor.sealsTrustAnchored ?? undefined;
  result.anchorsChecked = cursor.anchorsChecked;
  result.anchorsTrustAnchored = cursor.anchorsTrustAnchored;
}

function boundsFor(snapshot: BoundsSnapshot, cursor: ChainCursor): SegmentBounds {
  const lastAnchorId = snapshot.lastAnchorId ?? BigInt(0);
  return {
    maxAuditId: null,
    maxSealId: snapshot.maxSealId > cursor.sealId ? snapshot.maxSealId : cursor.sealId,
    maxAnchorId: lastAnchorId > cursor.anchorId ? lastAnchorId : cursor.anchorId,
  };
}

/**
 * Beschreibt die erste Positionsabweichung zwischen Vollprüfung und Ziel.
 * Verglichen werden nur prüfergebnisunabhängige Felder: Kettenposition und
 * -hash, Zahl der Einträge, verarbeitete Siegel und Anker.
 */
export function cursorMismatch(actual: ChainCursor, expected: ChainCursor): string | null {
  if (actual.auditId !== expected.auditId) {
    return `Audit-ID ${actual.auditId} statt ${expected.auditId}`;
  }
  if (!actual.auditHash.equals(expected.auditHash)) {
    return `Ketten-Hash an Audit-ID ${expected.auditId} weicht ab`;
  }
  if (actual.auditCount !== expected.auditCount) {
    return `${actual.auditCount} statt ${expected.auditCount} Audit-Einträge`;
  }
  if (actual.sealsChecked !== expected.sealsChecked) {
    return `${actual.sealsChecked} statt ${expected.sealsChecked} Tagesversiegelungen`;
  }
  if (actual.anchorId !== expected.anchorId) {
    return `externe Ankerkette endet bei Anker ${actual.anchorId} statt ${expected.anchorId}`;
  }
  if (actual.anchorsChecked !== expected.anchorsChecked) {
    return `${actual.anchorsChecked} statt ${expected.anchorsChecked} Rolling-Anker`;
  }
  return null;
}

/** Prüfergebnis bereits verarbeiteter Siegel/Anker weicht ab (Trust-Store, Daten). */
function outcomeChanged(actual: StoredVerifyCheckpoint, expected: StoredVerifyCheckpoint): boolean {
  const a = actual.cursor;
  const e = expected.cursor;
  return (
    !a.anchorHash.equals(e.anchorHash) ||
    a.anchorTopAuditId !== e.anchorTopAuditId ||
    a.sealsTrustAnchored !== e.sealsTrustAnchored ||
    a.anchorsTrustAnchored !== e.anchorsTrustAnchored ||
    canonicalJson(sortedFindings(actual.findings)) !==
      canonicalJson(sortedFindings(expected.findings))
  );
}

// -----------------------------------------------------------------------------
// Befunde
// -----------------------------------------------------------------------------

export function emptyFindings(): CheckpointFindings {
  return { seals: [], anchors: [], omittedSeals: 0, omittedAnchors: 0 };
}

/**
 * Ergänzt die Befunde eines Abschnitts. Je Art bleiben die MAX_STORED_FINDINGS
 * Befunde mit den niedrigsten IDs gespeichert (aufsteigend sortiert), die
 * übrigen werden nur gezählt. Jedes Siegel und jeder Anker wird je Prüflinie
 * genau einmal verarbeitet; der gespeicherte Ausschnitt hängt deshalb nicht
 * von der Verarbeitungsreihenfolge ab, und Zuwachs- und Vollprüfung speichern
 * bei gleichem Kettenstand dieselben Befunde.
 */
export function mergeFindings(
  base: CheckpointFindings,
  outcome: Pick<SegmentOutcome, 'sealBreaks' | 'anchorBreaks'>,
): CheckpointFindings {
  const merged = sortedFindings(base);
  for (const b of outcome.sealBreaks) {
    merged.omittedSeals += insertById(merged.seals, {
      id: String(b.sealId),
      date: b.sealDate.toISOString(),
      top: String(b.topAuditId),
      reason: b.reason,
    });
  }
  for (const b of outcome.anchorBreaks) {
    merged.omittedAnchors += insertById(merged.anchors, {
      id: String(b.anchorId),
      top: String(b.topAuditId),
      reason: b.reason,
    });
  }
  return merged;
}

/**
 * Fügt einen Befund in die nach ID sortierte Liste ein (gleiche ID: ersetzen).
 * Über der Obergrenze entfällt der Befund mit der höchsten ID; dann 1.
 */
function insertById<T extends { id: string }>(list: T[], finding: T): number {
  const id = BigInt(finding.id);
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (BigInt(list[middle]!.id) < id) low = middle + 1;
    else high = middle;
  }
  if (low < list.length && BigInt(list[low]!.id) === id) {
    list[low] = finding;
    return 0;
  }
  if (list.length < MAX_STORED_FINDINGS) {
    list.splice(low, 0, finding);
    return 0;
  }
  if (low === list.length) return 1;
  list.splice(low, 0, finding);
  list.pop();
  return 1;
}

/** Befunde zweier Stände für die Meldung; bei gleicher ID gilt `preferred`. */
function unionFindings(
  base: CheckpointFindings,
  preferred: CheckpointFindings,
): CheckpointFindings {
  const union = sortedFindings(base);
  union.omittedSeals = 0;
  union.omittedAnchors = 0;
  let droppedSeals = 0;
  let droppedAnchors = 0;
  for (const seal of preferred.seals) droppedSeals += insertById(union.seals, seal);
  for (const anchor of preferred.anchors) droppedAnchors += insertById(union.anchors, anchor);
  // Untergrenze der nicht einzeln gehaltenen Befunde beider Stände.
  const totalSeals = Math.max(
    base.seals.length + base.omittedSeals,
    preferred.seals.length + preferred.omittedSeals,
    union.seals.length + droppedSeals,
  );
  const totalAnchors = Math.max(
    base.anchors.length + base.omittedAnchors,
    preferred.anchors.length + preferred.omittedAnchors,
    union.anchors.length + droppedAnchors,
  );
  union.omittedSeals = totalSeals - union.seals.length;
  union.omittedAnchors = totalAnchors - union.anchors.length;
  return union;
}

/** Befunde außerhalb des von einer Vollprüfung bis `target` abgedeckten Bereichs. */
function uncoveredFindings(findings: CheckpointFindings, target: ChainCursor): CheckpointFindings {
  return {
    seals: findings.seals.filter(
      (seal) => BigInt(seal.id) > target.sealId || BigInt(seal.top) > target.auditId,
    ),
    anchors: findings.anchors.filter((anchor) => BigInt(anchor.id) > target.anchorId),
    omittedSeals: 0,
    omittedAnchors: 0,
  };
}

function sortedFindings(findings: CheckpointFindings): CheckpointFindings {
  const byId = (a: { id: string }, b: { id: string }) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  return {
    seals: [...findings.seals].sort(byId),
    anchors: [...findings.anchors].sort(byId),
    omittedSeals: findings.omittedSeals,
    omittedAnchors: findings.omittedAnchors,
  };
}

/**
 * Meldet die Befunde in der Reihenfolge von verifyChain (Siegeldatum, Anker-ID),
 * einschließlich der Siegel, deren Spitze jenseits des Kettenendes liegt.
 */
function reportFindings(
  result: VerificationResult,
  findings: CheckpointFindings,
  danglingSeals: SegmentSealBreak[],
): void {
  const stored = new Set(findings.seals.map((seal) => seal.id));
  const seals = [
    ...findings.seals.map((seal) => ({ date: seal.date, reason: seal.reason })),
    ...danglingSeals
      .filter((seal) => !stored.has(String(seal.sealId)))
      .map((seal) => ({ date: seal.sealDate.toISOString(), reason: seal.reason })),
  ];
  result.sealBreaks = seals
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((seal) => ({ sealDate: new Date(seal.date), reason: seal.reason }));
  result.anchorBreaks = sortedFindings(findings).anchors.map((anchor) => ({
    anchorId: BigInt(anchor.id),
    topAuditId: BigInt(anchor.top),
    reason: anchor.reason,
  }));
  const omitted = findings.omittedSeals + findings.omittedAnchors;
  if (omitted > 0) {
    result.policyBreaks.push(
      `${omitted} weitere Siegel-/Ankerbefunde nicht einzeln gespeichert ` +
        `(mehr als ${MAX_STORED_FINDINGS} je Art).`,
    );
  }
}

function parseFindings(value: unknown): CheckpointFindings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === 'string';
  const count = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  const seals = v['seals'];
  const anchors = v['anchors'];
  if (!Array.isArray(seals) || !Array.isArray(anchors)) return null;
  if (!count(v['omittedSeals']) || !count(v['omittedAnchors'])) return null;
  const sealOk = seals.every(
    (s) => s && text(s.id) && text(s.date) && text(s.top) && text(s.reason),
  );
  const anchorOk = anchors.every((a) => a && text(a.id) && text(a.top) && text(a.reason));
  if (!sealOk || !anchorOk) return null;
  return {
    seals: seals.map((s) => ({ id: s.id, date: s.date, top: s.top, reason: s.reason })),
    anchors: anchors.map((a) => ({ id: a.id, top: a.top, reason: a.reason })),
    omittedSeals: v['omittedSeals'] as number,
    omittedAnchors: v['omittedAnchors'] as number,
  };
}

// -----------------------------------------------------------------------------
// Checkpoint-Integrität
// -----------------------------------------------------------------------------

/**
 * Prüft, ob ein gespeicherter Checkpoint noch zur gespeicherten Kette passt:
 * die Zeile an seiner Position existiert, reproduziert ihren Hash und dieser
 * entspricht dem Checkpoint; Anzahl der Einträge, der verarbeiteten Siegel
 * (id ≤ seal_id UND Spitze ≤ audit_id, dieselbe Regel wie der Prüfstand) und
 * der verarbeiteten Anker bis zur Position stimmen; der zuletzt gültige Anker
 * (erwarteter Vorgänger des nächsten) ist unverändert vorhanden.
 * Liefert die Abweichung oder null.
 */
export async function checkpointIntegrityProblem(
  tx: EvidenceTx,
  tenantId: string,
  cursor: ChainCursor,
): Promise<string | null> {
  if (cursor.auditId === BigInt(0)) {
    if (!cursor.auditHash.equals(genesisHash(tenantId)) || cursor.auditCount !== 0) {
      return 'Genesis-Stand ist inkonsistent';
    }
  } else {
    const row = await recomputeStoredRow(tx, tenantId, cursor.auditId);
    if (row.kind === 'missing') return `Audit-ID ${cursor.auditId} existiert nicht mehr`;
    if (row.kind === 'broken') {
      return `Audit-Eintrag ${cursor.auditId} reproduziert seinen gespeicherten Hash nicht`;
    }
    if (!row.hash.equals(cursor.auditHash)) {
      return `Ketten-Hash an Audit-ID ${cursor.auditId} weicht ab`;
    }
  }

  const rows = await tx.$queryRaw<
    Array<{ audit_count: bigint; seal_count: bigint; anchor_count: bigint; state_count: bigint }>
  >`
    SELECT
      (SELECT count(*) FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid AND id <= ${cursor.auditId})::bigint AS audit_count,
      (SELECT count(*) FROM audit_seal
        WHERE tenant_id = ${tenantId}::uuid
          AND id <= ${cursor.sealId}
          AND top_audit_id <= ${cursor.auditId})::bigint AS seal_count,
      (SELECT count(*) FROM audit_anchor
        WHERE tenant_id = ${tenantId}::uuid AND id <= ${cursor.anchorId})::bigint AS anchor_count,
      (SELECT count(*) FROM audit_anchor
        WHERE tenant_id = ${tenantId}::uuid
          AND id <= ${cursor.anchorId}
          AND anchor_hash = ${cursor.anchorHash}
          AND top_audit_id = ${cursor.anchorTopAuditId})::bigint AS state_count
  `;
  const counts = rows[0]!;
  if (Number(counts.audit_count) !== cursor.auditCount) {
    return (
      `${Number(counts.audit_count)} statt ${cursor.auditCount} Audit-Einträge ` +
      `bis Audit-ID ${cursor.auditId}`
    );
  }
  if (Number(counts.seal_count) !== cursor.sealsChecked) {
    return `${Number(counts.seal_count)} statt ${cursor.sealsChecked} Tagesversiegelungen`;
  }
  if (Number(counts.anchor_count) !== cursor.anchorsChecked) {
    return `${Number(counts.anchor_count)} statt ${cursor.anchorsChecked} Rolling-Anker`;
  }
  if (cursor.anchorHash.equals(anchorGenesisHash(tenantId))) {
    // Noch kein gültiger Anker (keiner oder nur ungültige verarbeitet).
    if (cursor.anchorTopAuditId !== BigInt(0)) {
      return 'Genesis-Stand der Ankerkette ist inkonsistent';
    }
  } else if (Number(counts.state_count) < 1) {
    return 'zuletzt gültiger Rolling-Anker fehlt oder weicht ab';
  }
  return null;
}

// -----------------------------------------------------------------------------
// Persistenz (nur Owner-Verbindung; die App-Rolle darf die Tabelle nur lesen)
// -----------------------------------------------------------------------------

/** HMAC-SHA256 über alle Felder eines Checkpoints einschließlich Tenant und Art. */
export function checkpointMac(key: Buffer, tenantId: string, state: CheckpointState): Buffer {
  const c = state.cursor;
  const payload = canonicalJson({
    tenantId: tenantId.toLowerCase(),
    kind: state.kind,
    sweepId: state.sweepId,
    auditId: c.auditId.toString(),
    auditHash: c.auditHash.toString('hex'),
    auditCount: c.auditCount,
    sealId: c.sealId.toString(),
    sealsChecked: c.sealsChecked,
    sealsTrustAnchored: c.sealsTrustAnchored,
    anchorId: c.anchorId.toString(),
    anchorHash: c.anchorHash.toString('hex'),
    anchorTopAuditId: c.anchorTopAuditId.toString(),
    anchorsChecked: c.anchorsChecked,
    anchorsTrustAnchored: c.anchorsTrustAnchored,
    findings: state.findings,
    startedAt: state.startedAt.toISOString(),
    verifiedAt: state.verifiedAt.toISOString(),
    completedAt: state.completedAt?.toISOString() ?? null,
  });
  return createHmac('sha256', key).update(MAC_CONTEXT).update(payload, 'utf8').digest();
}

/**
 * Lädt einen Checkpoint und prüft seine Prüfsumme sowie seine Zeitstempel.
 * `invalid`: nicht authentisch oder in der Zukunft datiert.
 */
export async function loadVerifyCheckpoint(
  tx: EvidenceTx,
  key: Buffer,
  tenantId: string,
  kind: VerifyCheckpointKind,
  now: Date,
): Promise<LoadedVerifyCheckpoint> {
  const rows = await tx.$queryRaw<CheckpointRow[]>`
    SELECT audit_id, audit_hash, audit_count, seal_id, seals_checked, seals_trust_anchored,
           anchor_id, anchor_hash, anchor_top_audit_id, anchors_checked, anchors_trust_anchored,
           started_at, verified_at, completed_at, findings, sweep_id::text AS sweep_id, mac
    FROM audit_verify_checkpoint
    WHERE tenant_id = ${tenantId}::uuid
      AND kind = ${kind}
  `;
  const row = rows[0];
  if (!row) return { status: 'missing' };
  const findings = parseFindings(row.findings);
  if (!findings) return { status: 'invalid', problem: 'Befundliste ist unlesbar' };
  const state: CheckpointState = {
    kind,
    cursor: {
      auditId: row.audit_id,
      auditHash: Buffer.from(row.audit_hash),
      auditCount: Number(row.audit_count),
      sealId: row.seal_id,
      sealsChecked: Number(row.seals_checked),
      sealsTrustAnchored:
        row.seals_trust_anchored === null ? null : Number(row.seals_trust_anchored),
      anchorId: row.anchor_id,
      anchorHash: Buffer.from(row.anchor_hash),
      anchorTopAuditId: row.anchor_top_audit_id,
      anchorsChecked: Number(row.anchors_checked),
      anchorsTrustAnchored: Number(row.anchors_trust_anchored),
    },
    findings,
    sweepId: row.sweep_id,
    startedAt: row.started_at,
    verifiedAt: row.verified_at,
    completedAt: row.completed_at,
  };
  const mac = Buffer.from(row.mac);
  const expected = checkpointMac(key, tenantId, state);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return { status: 'invalid', problem: 'Prüfsumme (MAC) fehlt oder ist ungültig' };
  }
  const latest = now.getTime() + CLOCK_SKEW_TOLERANCE_MS;
  const stamps = [state.startedAt, state.verifiedAt, state.completedAt];
  if (stamps.some((stamp) => stamp !== null && stamp.getTime() > latest)) {
    return { status: 'invalid', problem: 'Zeitstempel liegt in der Zukunft' };
  }
  return { status: 'ok', checkpoint: { ...state, mac } };
}

async function insertCheckpoint(
  tx: EvidenceTx,
  ctx: Pick<RunContext, 'key' | 'tenantId'>,
  state: CheckpointState,
): Promise<StoredVerifyCheckpoint | null> {
  const mac = checkpointMac(ctx.key, ctx.tenantId, state);
  const c = state.cursor;
  const inserted = await tx.$executeRaw`
    INSERT INTO audit_verify_checkpoint (
      tenant_id, kind, audit_id, audit_hash, audit_count,
      seal_id, seals_checked, seals_trust_anchored,
      anchor_id, anchor_hash, anchor_top_audit_id, anchors_checked, anchors_trust_anchored,
      started_at, verified_at, completed_at, findings, sweep_id, mac
    ) VALUES (
      ${ctx.tenantId}::uuid, ${state.kind}, ${c.auditId}, ${c.auditHash}, ${c.auditCount},
      ${c.sealId}, ${c.sealsChecked}, ${c.sealsTrustAnchored},
      ${c.anchorId}, ${c.anchorHash}, ${c.anchorTopAuditId}, ${c.anchorsChecked},
      ${c.anchorsTrustAnchored},
      ${state.startedAt}, ${state.verifiedAt}, ${state.completedAt},
      ${JSON.stringify(state.findings)}::jsonb, ${state.sweepId}::uuid, ${mac}
    )
    ON CONFLICT (tenant_id, kind) DO NOTHING
  `;
  return inserted === 1 ? { ...state, mac } : null;
}

/**
 * Compare-and-set über die Prüfsumme: schreibt nur fort, wenn die Zeile noch
 * genau dem gelesenen Stand entspricht. So kann ein paralleler Lauf weder
 * überholt noch zurückgesetzt werden. `verified_at` liegt danach streng nach
 * dem der ersetzten Zeile, auch bei abweichender Uhr des schreibenden Workers.
 */
async function updateCheckpoint(
  tx: EvidenceTx,
  ctx: Pick<RunContext, 'key' | 'tenantId' | 'clock'>,
  previous: StoredVerifyCheckpoint,
  changes: Partial<
    Pick<CheckpointState, 'cursor' | 'findings' | 'sweepId' | 'startedAt' | 'completedAt'>
  >,
): Promise<StoredVerifyCheckpoint | null> {
  const { mac: previousMac, ...rest } = previous;
  const now = ctx.clock();
  const verifiedAt =
    now.getTime() > previous.verifiedAt.getTime()
      ? now
      : new Date(previous.verifiedAt.getTime() + 1);
  const state: CheckpointState = { ...rest, ...changes, verifiedAt };
  const mac = checkpointMac(ctx.key, ctx.tenantId, state);
  const c = state.cursor;
  const updated = await tx.$executeRaw`
    UPDATE audit_verify_checkpoint
    SET audit_id = ${c.auditId},
        audit_hash = ${c.auditHash},
        audit_count = ${c.auditCount},
        seal_id = ${c.sealId},
        seals_checked = ${c.sealsChecked},
        seals_trust_anchored = ${c.sealsTrustAnchored},
        anchor_id = ${c.anchorId},
        anchor_hash = ${c.anchorHash},
        anchor_top_audit_id = ${c.anchorTopAuditId},
        anchors_checked = ${c.anchorsChecked},
        anchors_trust_anchored = ${c.anchorsTrustAnchored},
        started_at = ${state.startedAt},
        verified_at = ${state.verifiedAt},
        completed_at = ${state.completedAt},
        findings = ${JSON.stringify(state.findings)}::jsonb,
        sweep_id = ${state.sweepId}::uuid,
        mac = ${mac}
    WHERE tenant_id = ${ctx.tenantId}::uuid
      AND kind = ${state.kind}
      AND mac = ${previousMac}
  `;
  return updated === 1 ? { ...state, mac } : null;
}

async function deleteVerifyCheckpoints(
  tx: EvidenceTx,
  tenantId: string,
  kinds: VerifyCheckpointKind[],
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM audit_verify_checkpoint
    WHERE tenant_id = ${tenantId}::uuid
      AND kind = ANY(${kinds}::text[])
  `;
}

async function hasVerifyCheckpoints(
  tx: EvidenceTx,
  tenantId: string,
  kinds: VerifyCheckpointKind[],
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM audit_verify_checkpoint
      WHERE tenant_id = ${tenantId}::uuid
        AND kind = ANY(${kinds}::text[])
    ) AS present
  `;
  return rows[0]?.present === true;
}

async function loadBoundsSnapshot(tx: EvidenceTx, tenantId: string): Promise<BoundsSnapshot> {
  const rows = await tx.$queryRaw<
    Array<{
      max_seal_id: bigint;
      last_anchor_id: bigint | null;
      last_anchor_top_audit_id: bigint | null;
    }>
  >`
    SELECT
      COALESCE(
        (SELECT max(id) FROM audit_seal WHERE tenant_id = ${tenantId}::uuid),
        0
      )::bigint AS max_seal_id,
      latest.id AS last_anchor_id,
      latest.top_audit_id AS last_anchor_top_audit_id
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT id, top_audit_id
      FROM audit_anchor
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id DESC
      LIMIT 1
    ) AS latest ON true
  `;
  const row = rows[0]!;
  return {
    maxSealId: row.max_seal_id,
    lastAnchorId: row.last_anchor_id,
    lastAnchorTopAuditId: row.last_anchor_top_audit_id,
  };
}

/**
 * Wie verifyChain: Einträge oberhalb der letzten Ankerspitze bis zur geprüften
 * Kettenspitze gelten als lokal noch nicht extern verankert.
 */
async function fillUnanchoredSummary(
  tx: EvidenceTx,
  tenantId: string,
  result: VerificationResult,
): Promise<void> {
  result.unanchoredEntries = 0;
  result.oldestUnanchoredAt = null;
  if (result.lastAuditId === null) return;
  const from = result.lastAnchoredAuditId ?? BigInt(0);
  const rows = await tx.$queryRaw<Array<{ entries: bigint; oldest: Date | null }>>`
    SELECT
      count(*)::bigint AS entries,
      (SELECT occurred_at FROM audit_log
        WHERE tenant_id = ${tenantId}::uuid AND id > ${from} AND id <= ${result.lastAuditId}
        ORDER BY id ASC
        LIMIT 1) AS oldest
    FROM audit_log
    WHERE tenant_id = ${tenantId}::uuid
      AND id > ${from}
      AND id <= ${result.lastAuditId}
  `;
  result.unanchoredEntries = Number(rows[0]?.entries ?? 0);
  result.oldestUnanchoredAt = rows[0]?.oldest ?? null;
}
