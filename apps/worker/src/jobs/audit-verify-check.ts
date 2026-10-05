// =============================================================================
// audit-verify-check-Worker
//
// Verifiziert die Hash-Chain pro Tenant. Bei Bruch → SYSTEM_AUDIT_BREAK
// Notification an alle ADMIN/PARTNER. Idempotent (notify dedupliziert).
// P-04: täglich der Zuwachs ab dem Prüf-Checkpoint, periodisch bzw. manuell
// eine fortsetzbare Vollprüfung ab Genesis (packages/evidence/verify-checkpoint).
// =============================================================================

import { createWorker } from '../worker-factory';
import { env } from '@taxtronik/config';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { deriveAuditCheckpointMacKey } from '@taxtronik/crypto';
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { prismaOwner } from '../prisma-owner';
import {
  EvidenceService,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  toPersistedVerifyResult,
  verifyChainWithCheckpoints,
  type CheckpointedVerifyOptions,
  type PersistedRecoveryCheckpoint,
  type PersistedVerifyResult,
  type VerificationResult,
} from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { withWorkerTenantContext } from '../tenant-context';
import { timestampPortFor } from '../tsa-port';

// RF-5: Produktivmodus → externe TSA verpflichtend (Self-Timestamp = harter
// Fail). Symmetrisch zur CLI (packages/evidence/src/cli/verify.ts) — vorher
// lief der tägliche Check immer ohne Policy-Prüfung und ein Self-Timestamp
// in Produktion wäre nie aufgefallen.
const requireExternalTsa =
  env.NODE_ENV === 'production' || process.env['EVIDENCE_REQUIRE_TSA'] === 'true';

// P-1/P-04: Der Prisma-Default (5 s) riss beim Walk P2028. Seit P-04 läuft
// jeder Prüfabschnitt (höchstens 5.000 Einträge bzw. 250 Rolling-Anker) in
// einer eigenen Transaktion; 120 s bleiben die großzügige Obergrenze je
// Abschnitt und für die unveränderte Recovery-Teilkettenprüfung.
const VERIFY_TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 } as const;

// P-04 (AUDIT-VERIFY-ALERT-001): Täglich wird nur der Zuwachs ab dem
// Prüf-Checkpoint nachgerechnet. Liegt die letzte abgeschlossene Vollprüfung
// mindestens diese Frist zurück — und bei jedem manuellen Prüflauf —, beginnt
// eine Vollprüfung ab Genesis, die den Checkpoint bestätigen muss. Weil die
// vorige Vollprüfung erst nach Laufbeginn abschließt, ist das im täglichen Takt
// in der Regel der achte Lauf.
export const FULL_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Zeitbudget je Tenant und Lauf für die fortsetzbare Vollprüfung; der Rest
// folgt im nächsten Lauf ab dem gespeicherten Fortschritt.
export const FULL_VERIFY_BUDGET_MS = 10 * 60 * 1000;

export function checkpointedVerifyOptions(manual: boolean): CheckpointedVerifyOptions {
  return {
    requireExternalTsa,
    // HMAC-Schlüssel der Prüf-Checkpoints: HKDF aus dem vorhandenen
    // Worker-Geheimnis (SECRET_BOX_KEY bzw. AUTH_SECRET), eigenes Info-Label.
    checkpointKey: deriveAuditCheckpointMacKey(),
    fullVerifyIntervalMs: FULL_VERIFY_INTERVAL_MS,
    fullVerifyBudgetMs: FULL_VERIFY_BUDGET_MS,
    forceFullVerify: manual,
  };
}

// P-1: Ergebnis des Laufs persistieren (tenant_setting `audit_verify_result`)
// — die Admin-Audit-Seite zeigt NUR dieses Ergebnis, statt bei jedem Render
// selbst die komplette Chain zu hashen.
async function persistVerifyResult(tenantId: string, result: PersistedVerifyResult): Promise<void> {
  await withWorkerTenantContext(tenantId, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId,
      key: AUDIT_VERIFY_RESULT_SETTING_KEY,
      value: result,
    });
  });
}

// M-2/N-3: Tail-Truncation-Erkennung. Die höchste Audit-ID darf zwischen zwei
// Läufen NICHT schrumpfen — audit_log ist append-only, und die Archiv-Rotation
// entfernt nur die ältesten (niedrigsten) IDs, nie die neuesten. Ein kleinerer
// oder verschwundener Anker beweist gelöschte Spitzen-Einträge. Gibt die
// Alarm-Begründung zurück oder null, wenn alles monoton ist.
export function detectTailTruncation(
  prev: PersistedVerifyResult | null,
  newLastAuditId: bigint | null,
): string | null {
  if (!prev) return null; // erster Lauf — kein Anker
  const prevLast = prev.lastAuditId ? BigInt(prev.lastAuditId) : null;
  if (prevLast === null) return null; // kein früherer Anker (Altdatensatz/leer)
  if (newLastAuditId === null) {
    return `Audit-Kette ist leer, obwohl zuvor bis Audit-ID ${prevLast} geprüft wurde — Spitzen-Einträge gelöscht.`;
  }
  if (newLastAuditId < prevLast) {
    return `Höchste Audit-ID von ${prevLast} auf ${newLastAuditId} gesunken — die neuesten Einträge wurden gelöscht (Tail-Truncation).`;
  }
  return null;
}

/**
 * Same monotonicity guard for the append-only external anchor chain. Verifying
 * the remaining rows detects gaps in the middle, but deleting only the newest
 * anchor would otherwise merely look like a larger locally pending tail.
 */
export function detectAnchorTailTruncation(
  prev: PersistedVerifyResult | null,
  newLastAnchorId: bigint | null,
): string | null {
  if (!prev?.lastAnchorId) return null;
  const prevLast = BigInt(prev.lastAnchorId);
  if (newLastAnchorId === null) {
    return `Externe Anchor-Kette ist leer, obwohl zuvor bis Anchor-ID ${prevLast} geprüft wurde — externe Kettenspitze gelöscht.`;
  }
  if (newLastAnchorId < prevLast) {
    return `Höchste Anchor-ID von ${prevLast} auf ${newLastAnchorId} gesunken — externe Kettenspitze gelöscht (Tail-Truncation).`;
  }
  return null;
}

function detectMonotonicityBreaks(
  previous: PersistedVerifyResult | null,
  result: Pick<VerificationResult, 'firstBreak' | 'lastAuditId' | 'lastAnchorId'>,
): string[] {
  // Ein Hash-/Link-Bruch beendet den Walk vorzeitig; lastAuditId ist dann nur
  // die letzte GUTE ID und kein Ketten-Endpunkt. Seal-, Anchor- oder
  // Policy-Fehler entstehen dagegen nach einem vollstaendigen Audit-Walk und
  // duerfen die Monotoniepruefung nicht blind schalten.
  if (result.firstBreak) return [];
  return [
    detectTailTruncation(previous, result.lastAuditId),
    detectAnchorTailTruncation(previous, result.lastAnchorId),
  ].filter((reason): reason is string => !!reason);
}

/** AUDIT-VERIFY-ALERT-001: einmal beobachtete Spitzen nie zuruecksetzen. */
export function preserveMonotonicId(
  previous: string | null | undefined,
  measured: string | null | undefined,
): string | null {
  if (!previous) return measured ?? null;
  if (!measured) return previous;
  return BigInt(previous) >= BigInt(measured) ? previous : measured;
}

function auditBreakBody(
  result: Pick<VerificationResult, 'firstBreak' | 'sealBreaks' | 'anchorBreaks' | 'policyBreaks'>,
  monotonicityReason: string | null,
): string {
  if (result.firstBreak) {
    return `Erster Bruch bei Audit-ID ${result.firstBreak.auditId} (${new Date(result.firstBreak.occurredAt).toISOString()})`;
  }
  return (
    monotonicityReason ??
    result.sealBreaks[0]?.reason ??
    result.anchorBreaks[0]?.reason ??
    result.policyBreaks[0] ??
    'Verifikation fehlgeschlagen.'
  );
}

function isTailTruncation(reason: string): boolean {
  return reason.includes('Tail-Truncation') || reason.includes('Spitzen-Einträge gelöscht');
}

/**
 * Ein Checkpoint darf nur den konkret davor dokumentierten historischen
 * Befund abgrenzen. Ein alter Checkpoint allein ist niemals Freifahrtschein
 * fuer einen neuen Fehler.
 */
export function acceptsPreviousTailRecovery(
  previous: PersistedVerifyResult | null,
  checkpoint: PersistedRecoveryCheckpoint | null,
): boolean {
  if (!previous || !checkpoint || previous.ok || previous.error) return false;
  if (!previous.policyBreaks.some(isTailTruncation)) return false;
  return Date.parse(checkpoint.createdAt) >= Date.parse(previous.checkedAt);
}

async function notifyAuditBreak(
  tenantId: string,
  input: { title?: string; body: string; resourceId: string | null },
): Promise<void> {
  await withWorkerTenantContext(tenantId, async (tx) => {
    const recipients = await tx.staffUser.findMany({
      where: {
        tenantId,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
    for (const rec of recipients) {
      const existing = await tx.notification.findFirst({
        where: {
          tenantId,
          staffId: rec.id,
          kind: 'SYSTEM_AUDIT_BREAK',
          resourceType: 'audit_log',
          readAt: null,
        },
      });
      const data = {
        tenantId,
        staffId: rec.id,
        kind: 'SYSTEM_AUDIT_BREAK' as const,
        title: input.title ?? `⚠ Audit-Hash-Chain gebrochen!`,
        body: input.body,
        href: `/staff/admin/audit`,
        resourceType: 'audit_log',
        resourceId: input.resourceId,
      };
      if (existing) {
        await tx.notification.update({
          where: { id: existing.id },
          data: { ...data, createdAt: new Date() },
        });
      } else {
        await tx.notification.create({ data });
      }
    }
  });
}

// M7: Tenant-Pagination. Bei vielen Tenants würde `findMany({})` ohne
// Limit alle Records in Memory laden, und die anschließende sequenzielle
// `evidenceService.verifyChain(tx, tenantId)`-Loop könnte Stunden laufen.
// Wir chunken in 50er-Blöcken; pro Chunk wird sequenziell verifiziert.
const TENANT_CHUNK_SIZE = 50;

async function loadTenantIdsChunked(): Promise<AsyncGenerator<string[]>> {
  async function* gen(): AsyncGenerator<string[]> {
    let cursor: string | undefined;
    while (true) {
      const rows = await prismaOwner.tenant.findMany({
        select: { id: true },
        take: TENANT_CHUNK_SIZE,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (rows.length === 0) return;
      yield rows.map((t) => t.id);
      if (rows.length < TENANT_CHUNK_SIZE) return;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  return gen();
}

interface AuditVerifyEntry {
  tenantId: string;
  ok: boolean;
  broken?: string;
  /** Vollprüfung nach diesem Lauf noch nicht abgeschlossen. */
  fullVerificationPending?: boolean;
}

interface TenantVerificationRun {
  checkedAt: Date;
  result: VerificationResult;
  recoveryResult: VerificationResult | null;
  recovered: boolean;
}

interface TenantVerificationOutcome {
  persisted: PersistedVerifyResult;
  freshFailure: boolean;
  recovered: boolean;
  monotonicityReason: string | null;
  failureResult: VerificationResult;
}

async function loadPreviousVerifyResult(tenantId: string): Promise<PersistedVerifyResult | null> {
  const value = await withWorkerTenantContext(tenantId, (tx) =>
    readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY),
  );
  return (value ?? null) as PersistedVerifyResult | null;
}

async function verifyTenantChain(
  tenantId: string,
  previous: PersistedVerifyResult | null,
  checkedAt: Date,
  manual: boolean,
): Promise<TenantVerificationRun> {
  const timestampPort = await timestampPortFor(tenantId);
  const evidenceService = new EvidenceService(timestampPort);
  // P-04: Zuwachs ab Prüf-Checkpoint plus fällige Vollprüfung, je Abschnitt
  // eine Owner-Transaktion. Das Ergebnis hat dieselbe Bedeutung wie
  // verifyChain (kumulierte Zähler, geprüfte Kettenspitze, Brüche).
  const result = await verifyChainWithCheckpoints(
    evidenceService,
    (work) => prismaOwner.$transaction((tx) => work(tx), VERIFY_TX_OPTIONS),
    tenantId,
    checkpointedVerifyOptions(manual),
  );
  const checkpointValue = await withWorkerTenantContext(tenantId, (tx) =>
    readTenantSettingValue(tx, tenantId, AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY),
  );
  const checkpoint = (checkpointValue ?? null) as PersistedRecoveryCheckpoint | null;

  // AUDIT-VERIFY-ALERT-001: Ein Checkpoint allein unterdrueckt keinen Alarm.
  // Die konkrete Teilkette ab dem Checkpoint muss technisch intakt sein.
  let recoveryResult: VerificationResult | null = null;
  let recovered = false;
  if (checkpoint && result.firstBreak && result.firstBreak.auditId < BigInt(checkpoint.auditId)) {
    recoveryResult = await prismaOwner.$transaction(
      (tx) =>
        evidenceService.verifyRecoverySegment(tx, tenantId, BigInt(checkpoint.auditId), {
          requireExternalTsa,
        }),
      VERIFY_TX_OPTIONS,
    );
    recovered = recoveryResult.ok;
  } else if (checkpoint && result.ok) {
    recovered = previous?.recovered === true || acceptsPreviousTailRecovery(previous, checkpoint);
  }
  return { checkedAt, result, recoveryResult, recovered };
}

function evaluateTenantVerification(
  previous: PersistedVerifyResult | null,
  run: TenantVerificationRun,
  requestId: string | null,
): TenantVerificationOutcome {
  const endpoint = run.recoveryResult
    ? {
        firstBreak: run.recoveryResult.firstBreak,
        lastAuditId: run.recoveryResult.lastAuditId,
        lastAnchorId: run.result.lastAnchorId,
      }
    : run.result;
  const monotonicityBreaks = detectMonotonicityBreaks(previous, endpoint);
  const monotonicityReason = monotonicityBreaks[0] ?? null;
  const recovered = monotonicityBreaks.length > 0 ? false : run.recovered;
  const freshFailure = monotonicityBreaks.length > 0 || (!run.result.ok && !recovered);
  const persistedOk = run.result.ok && monotonicityBreaks.length === 0 && !recovered;
  const failureResult =
    run.recoveryResult && !run.recoveryResult.ok ? run.recoveryResult : run.result;
  const base = toPersistedVerifyResult(failureResult, run.checkedAt);
  const carriedHistoricalBreaks = recovered ? (previous?.policyBreaks ?? []) : [];
  const measuredLastAuditId = endpoint.lastAuditId === null ? null : String(endpoint.lastAuditId);

  return {
    freshFailure,
    recovered,
    monotonicityReason,
    failureResult,
    persisted: {
      ...base,
      ok: persistedOk,
      checked: run.recoveryResult ? run.recoveryResult.checked : base.checked,
      // Ein negativer Lauf darf die gespeicherten Monotonie-Anker nie senken.
      lastAuditId: preserveMonotonicId(previous?.lastAuditId, measuredLastAuditId),
      lastAnchorId: preserveMonotonicId(
        previous?.lastAnchorId,
        run.result.lastAnchorId === null ? null : String(run.result.lastAnchorId),
      ),
      lastAnchoredAuditId: preserveMonotonicId(
        previous?.lastAnchoredAuditId,
        run.result.lastAnchoredAuditId === null ? null : String(run.result.lastAnchoredAuditId),
      ),
      policyBreaks: [
        ...new Set([...carriedHistoricalBreaks, ...base.policyBreaks, ...monotonicityBreaks]),
      ],
      requestId,
      recovered,
    },
  };
}

/**
 * P-04: Fortschritt einer nach diesem Lauf noch nicht abgeschlossenen
 * Vollprüfung (null = keine offen). Solange sie läuft, ist der Lauf nicht
 * abgeschlossen: keine Abschlussmeldung, offene Bruchmeldungen bleiben.
 */
export function pendingFullVerification(
  result: Pick<VerificationResult, 'incremental'>,
): { auditId: bigint; targetAuditId: bigint } | null {
  const running = result.incremental?.fullVerification;
  return running ? { auditId: running.auditId, targetAuditId: running.targetAuditId } : null;
}

/** Hinweis an den Auslöser eines manuellen Laufs, solange die Vollprüfung läuft. */
export function manualProgressMessage(progress: { auditId: bigint; targetAuditId: bigint }): {
  title: string;
  body: string;
} {
  return {
    title: 'Audit-Vollpruefung laeuft',
    body:
      `Manuelle Pruefung: Zuwachs geprueft, Vollpruefung ab Genesis bis Audit-ID ` +
      `${progress.auditId} von ${progress.targetAuditId}. Sie wird im naechsten Lauf ` +
      'fortgesetzt; die Abschlussmeldung folgt erst danach.',
  };
}

type NotificationTx = Parameters<Parameters<typeof withWorkerTenantContext>[1]>[0];

async function notifyManualRequester(
  tx: NotificationTx,
  input: { tenantId: string; requestedByStaffId: string | null },
  message: { title: string; body: string },
): Promise<void> {
  let recipients = input.requestedByStaffId
    ? await tx.staffUser.findMany({
        where: { tenantId: input.tenantId, id: input.requestedByStaffId, active: true },
        select: { id: true },
      })
    : await tx.staffUser.findMany({
        where: {
          tenantId: input.tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });
  if (recipients.length === 0) {
    recipients = await tx.staffUser.findMany({
      where: {
        tenantId: input.tenantId,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
  }
  for (const recipient of recipients) {
    const existing = await tx.notification.findFirst({
      where: {
        tenantId: input.tenantId,
        staffId: recipient.id,
        kind: 'SYSTEM_AUDIT_OK',
        resourceType: 'audit_log',
        readAt: null,
      },
    });
    const data = {
      tenantId: input.tenantId,
      staffId: recipient.id,
      kind: 'SYSTEM_AUDIT_OK' as const,
      title: message.title,
      body: message.body,
      href: '/staff/admin/audit',
      resourceType: 'audit_log',
      resourceId: null,
    };
    if (existing) {
      await tx.notification.update({
        where: { id: existing.id },
        data: { ...data, createdAt: new Date() },
      });
    } else {
      await tx.notification.create({ data });
    }
  }
}

async function clearBreakAndNotifySuccess(input: {
  tenantId: string;
  manualSingleTenant: boolean;
  requestedByStaffId: string | null;
  recovered: boolean;
  result: VerificationResult;
}): Promise<void> {
  await withWorkerTenantContext(input.tenantId, async (tx) => {
    await tx.notification.updateMany({
      where: { tenantId: input.tenantId, kind: 'SYSTEM_AUDIT_BREAK', readAt: null },
      data: { readAt: new Date() },
    });
    if (!input.manualSingleTenant) return;
    await notifyManualRequester(tx, input, {
      title: input.recovered
        ? 'Audit-Chain mit Recovery-Checkpoint geprueft'
        : 'Audit-Chain intakt',
      body: input.recovered
        ? `Manuelle Pruefung abgeschlossen: historischer Bruch bleibt abgegrenzt, ${input.result.checked} Audit-Eintraege geprueft.`
        : `Manuelle Pruefung abgeschlossen: ${input.result.checked} Audit-Eintraege und ${input.result.sealsChecked} Siegel geprueft.`,
    });
  }).catch((error) =>
    log.warn(
      { tenantId: input.tenantId, err: (error as Error).message },
      'audit-verify: clear-notification failed',
    ),
  );
}

/** Manueller Lauf mit noch laufender Vollprüfung: nur Fortschritt melden. */
async function notifyFullVerificationRunning(input: {
  tenantId: string;
  manualSingleTenant: boolean;
  requestedByStaffId: string | null;
  progress: { auditId: bigint; targetAuditId: bigint };
}): Promise<void> {
  if (!input.manualSingleTenant) return;
  await withWorkerTenantContext(input.tenantId, (tx) =>
    notifyManualRequester(tx, input, manualProgressMessage(input.progress)),
  ).catch((error) =>
    log.warn(
      { tenantId: input.tenantId, err: (error as Error).message },
      'audit-verify: progress-notification failed',
    ),
  );
}

async function handleTenantVerifyError(input: {
  tenantId: string;
  requestId: string | null;
  previous: PersistedVerifyResult | null;
  error: unknown;
}): Promise<AuditVerifyEntry> {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
  log.error({ tenantId: input.tenantId, err: errorMessage }, 'audit-verify: tenant failed');
  await persistVerifyResult(input.tenantId, {
    checkedAt: new Date().toISOString(),
    requestId: input.requestId,
    ok: false,
    checked: 0,
    lastAuditId: input.previous?.lastAuditId ?? null,
    lastAnchorId: input.previous?.lastAnchorId ?? null,
    lastAnchoredAuditId: input.previous?.lastAnchoredAuditId ?? null,
    sealsChecked: 0,
    sealBreaks: 0,
    policyBreaks: [],
    firstBreak: null,
    error: errorMessage,
    recovered: false,
  }).catch((error) =>
    log.warn(
      { tenantId: input.tenantId, err: (error as Error).message },
      'audit-verify: persist failed',
    ),
  );
  await notifyAuditBreak(input.tenantId, {
    title: '⚠ Audit-Prüflauf fehlgeschlagen!',
    body: `Audit-Prueflauf fehlgeschlagen: ${errorMessage}`,
    resourceId: null,
  }).catch((error) =>
    log.warn(
      { tenantId: input.tenantId, err: (error as Error).message },
      'audit-verify: notify failed',
    ),
  );
  return { tenantId: input.tenantId, ok: false, broken: 'verify-error' };
}

async function processAuditVerifyTenant(input: {
  tenantId: string;
  requestId: string | null;
  manualSingleTenant: boolean;
  requestedByStaffId: string | null;
}): Promise<AuditVerifyEntry> {
  let previous: PersistedVerifyResult | null = null;
  try {
    const checkedAt = new Date();
    previous = await loadPreviousVerifyResult(input.tenantId);
    const run = await verifyTenantChain(
      input.tenantId,
      previous,
      checkedAt,
      input.manualSingleTenant,
    );
    const outcome = evaluateTenantVerification(previous, run, input.requestId);
    await persistVerifyResult(input.tenantId, outcome.persisted);

    if (outcome.freshFailure) {
      await notifyAuditBreak(input.tenantId, {
        body: auditBreakBody(outcome.failureResult, outcome.monotonicityReason),
        resourceId: outcome.failureResult.firstBreak
          ? String(outcome.failureResult.firstBreak.auditId)
          : null,
      });
      return {
        tenantId: input.tenantId,
        ok: false,
        broken: outcome.failureResult.firstBreak
          ? String(outcome.failureResult.firstBreak.auditId)
          : 'unknown',
      };
    }

    const progress = pendingFullVerification(run.result);
    if (progress) {
      // Vollprüfung nicht abgeschlossen: keine Abschlussmeldung, offene
      // Bruchmeldungen bleiben bis zu einem abgeschlossenen sauberen Lauf.
      await notifyFullVerificationRunning({ ...input, progress });
      return { tenantId: input.tenantId, ok: true, fullVerificationPending: true };
    }
    await clearBreakAndNotifySuccess({
      tenantId: input.tenantId,
      manualSingleTenant: input.manualSingleTenant,
      requestedByStaffId: input.requestedByStaffId,
      recovered: outcome.recovered,
      result: run.result,
    });
    return { tenantId: input.tenantId, ok: true };
  } catch (error) {
    // P-04: Kein Lauf wird übersprungen. Ein paralleler Lauf desselben Tenants
    // wird im Prüflauf selbst übernommen; jede Exception ist ein Alarm.
    return handleTenantVerifyError({ ...input, previous, error });
  }
}

async function* singleTenantBatch(tenantId: string): AsyncGenerator<string[]> {
  yield [tenantId];
}

async function tenantBatchesFor(tenantId: string | undefined): Promise<AsyncGenerator<string[]>> {
  if (tenantId) return singleTenantBatch(tenantId);
  return loadTenantIdsChunked();
}

export const auditVerifyWorker = createWorker<ChecksJob>(
  JOB_QUEUES.auditVerify.name,
  async (job) => {
    const results: AuditVerifyEntry[] = [];
    const tenantBatches = await tenantBatchesFor(job.data.tenantId);
    for await (const tenantIds of tenantBatches) {
      for (const tenantId of tenantIds) {
        results.push(
          await processAuditVerifyTenant({
            tenantId,
            requestId: job.data.requestId ?? null,
            manualSingleTenant: Boolean(job.data.tenantId),
            requestedByStaffId: job.data.requestedByStaffId ?? null,
          }),
        );
      }
    }
    log.info({ results }, 'audit-verify: done');
    return { results };
  },
  { connection, concurrency: 1 },
);
