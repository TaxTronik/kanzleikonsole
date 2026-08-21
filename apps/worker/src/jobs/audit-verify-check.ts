// =============================================================================
// audit-verify-check-Worker
//
// Verifiziert die Hash-Chain pro Tenant. Bei Bruch → SYSTEM_AUDIT_BREAK
// Notification an alle ADMIN/PARTNER. Idempotent (notify dedupliziert).
// =============================================================================

import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { prismaOwner } from '../prisma-owner';
import {
  EvidenceService,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  toPersistedVerifyResult,
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

// P-1: verifyChain hasht JEDE audit_log-Zeile (SHA-256) — bei 500k+ Einträgen
// dauert der Walk Minuten. Der Prisma-Default (5 s) riss hier P2028 lange
// bevor der Lauf fertig war. Großzügiges Timeout nach dem Muster von
// TX_OPTIONS (@taxtronik/db), nur für den Verify-Walk dimensioniert.
const VERIFY_TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 } as const;

// P-1: Ergebnis des Laufs persistieren (tenant_setting `audit_verify_result`)
// — die Admin-Audit-Seite zeigt NUR dieses Ergebnis, statt bei jedem Render
// selbst die komplette Chain zu hashen.
async function persistVerifyResult(tenantId: string, result: PersistedVerifyResult): Promise<void> {
  await withWorkerTenantContext(tenantId, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
      create: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY, value: result as object },
      update: { value: result as object },
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
  result: Pick<VerificationResult, 'ok' | 'lastAuditId' | 'lastAnchorId'>,
): string[] {
  if (!result.ok) return [];
  return [
    detectTailTruncation(previous, result.lastAuditId),
    detectAnchorTailTruncation(previous, result.lastAnchorId),
  ].filter((reason): reason is string => !!reason);
}

function monotonicityOutcome(
  previous: PersistedVerifyResult | null,
  result: Pick<VerificationResult, 'ok' | 'lastAuditId' | 'lastAnchorId'>,
  recovered: boolean,
) {
  const breaks = detectMonotonicityBreaks(previous, result);
  const reason = breaks[0] ?? null;
  return {
    breaks,
    reason,
    effectiveOk: result.ok && !reason,
    suppressAlarm: recovered && !reason,
  };
}

function auditBreakBody(
  result: Pick<VerificationResult, 'firstBreak'>,
  monotonicityReason: string | null,
): string {
  if (result.firstBreak) {
    return `Erster Bruch bei Audit-ID ${result.firstBreak.auditId} (${new Date(result.firstBreak.occurredAt).toISOString()})`;
  }
  return monotonicityReason ?? 'Verifikation fehlgeschlagen.';
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

export const auditVerifyWorker = new Worker<ChecksJob>(
  'audit-verify-check',
  async (job) => {
    const results: Array<{ tenantId: string; ok: boolean; broken?: string }> = [];
    const manualSingleTenant = !!job.data.tenantId;
    const tenantBatches: AsyncGenerator<string[]> = job.data.tenantId
      ? (async function* () {
          yield [job.data.tenantId!];
        })()
      : await loadTenantIdsChunked();

    for await (const tenantIds of tenantBatches)
      for (const tenantId of tenantIds) {
        // Ausserhalb des try: der Fehlerpfad unten muss den Monotonie-Anker
        // weiterreichen können.
        let prev: PersistedVerifyResult | null = null;
        try {
          const checkedAt = new Date();
          // Vorergebnis VOR dem neuen Lauf lesen — liefert den Monotonie-Anker
          // (lastAuditId) für die Tail-Truncation-Erkennung unten.
          const prevRow = await withWorkerTenantContext(tenantId, (tx) =>
            tx.tenantSetting.findUnique({
              where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
            }),
          );
          prev = (prevRow?.value ?? null) as PersistedVerifyResult | null;

          const timestampPort = await timestampPortFor(tenantId);
          const evidenceService = new EvidenceService(timestampPort);
          const r = await prismaOwner.$transaction(
            async (tx) =>
              evidenceService.verifyChain(tx, tenantId, {
                requireExternalTsa,
              }),
            VERIFY_TX_OPTIONS,
          );

          // M-2/N-3: Monotonie-Anker gegen Tail-Truncation der UNVERSIEGELTEN
          // Spitze. Der Seal-Check oben fängt nur das Löschen VERSIEGELTER Einträge;
          // die neuesten, noch nicht tagesversiegelten Einträge (oder eine komplett
          // geleerte Kette) hinterlassen sonst eine konsistente Kette (ok=true).
          // Nur bei ok=true auswerten: bei einem Bruch ist lastAuditId die letzte
          // GUTE ID (früher Abbruch), kein echter Ketten-Endpunkt.
          // Recovery-Checkpoint = bewusste Abgrenzung durch den Admin. Er ist das
          // harte Kill-Signal für den Break-Alarm: sobald gesetzt, gilt der
          // historische Bruch als versorgt (recovered) — keine neue
          // SYSTEM_AUDIT_BREAK-Notification, und die bestehende wird als gelesen
          // markiert. Eine Teilketten-Verifikation (verifyRecoverySegment) hat
          // sich hier als fehleranfällig erwiesen (TSA-/Segment-Probleme) und das
          // Alarm-Verhalten unzuverlässig gemacht; der Checkpoint ist die
          // ausdrückliche Admin-Anweisung "Break versorgt". Ein FRISCHER
          // Schrumpf-Befund wird davon NICHT abgedeckt — das ist neue Manipulation.
          let recovered = false;
          if (!r.ok) {
            const cpRow = await withWorkerTenantContext(tenantId, (tx) =>
              tx.tenantSetting.findUnique({
                where: { tenantId_key: { tenantId, key: AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY } },
              }),
            );
            recovered = !!cpRow?.value;
          }

          const monotonicity = monotonicityOutcome(prev, r, recovered);
          const base = toPersistedVerifyResult(r, checkedAt);
          await persistVerifyResult(tenantId, {
            ...base,
            ok: monotonicity.effectiveOk,
            policyBreaks: [...base.policyBreaks, ...monotonicity.breaks],
            requestId: job.data.requestId ?? null,
            recovered,
          });

          if (!monotonicity.effectiveOk && !monotonicity.suppressAlarm) {
            // P-8: Notifications werden jetzt in einer Tenant-Context-Transaktion
            // geschrieben — auch wenn prismaOwner BYPASSRLS hat. Setzt die
            // app.current_*-Session-Variablen, sodass Audit-Trigger und etwaige
            // zukünftige RLS-Policies konsistent greifen. Symmetrisch zum
            // Web-App-Pattern (notify(tx, ...) innerhalb withTenantContext).
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
                  title: `⚠ Audit-Hash-Chain gebrochen!`,
                  body: auditBreakBody(r, monotonicity.reason),
                  href: `/staff/admin/audit`,
                  resourceType: 'audit_log',
                  resourceId: r.firstBreak ? String(r.firstBreak.auditId) : null,
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
            results.push({
              tenantId,
              ok: false,
              broken: r.firstBreak ? String(r.firstBreak.auditId) : 'unknown',
            });
          } else {
            // Chain intakt ODER historischer Bruch durch Checkpoint abgegrenzt
            // (recovered): eine noch offene SYSTEM_AUDIT_BREAK-Notification als
            // gelesen markieren, damit Bell/Counter nicht weiter auf einen Bruch
            // hinweist, der bereits versorgt ist. (User-Feedback: „nach Checkpoint
            // keine Break-Meldung/Notification mehr".)
            await withWorkerTenantContext(tenantId, async (tx) => {
              await tx.notification.updateMany({
                where: { tenantId, kind: 'SYSTEM_AUDIT_BREAK', readAt: null },
                data: { readAt: new Date() },
              });
              if (manualSingleTenant) {
                let recipients = job.data.requestedByStaffId
                  ? await tx.staffUser.findMany({
                      where: { tenantId, id: job.data.requestedByStaffId, active: true },
                      select: { id: true },
                    })
                  : await tx.staffUser.findMany({
                      where: {
                        tenantId,
                        active: true,
                        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
                      },
                      select: { id: true },
                    });
                if (recipients.length === 0) {
                  recipients = await tx.staffUser.findMany({
                    where: {
                      tenantId,
                      active: true,
                      roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
                    },
                    select: { id: true },
                  });
                }
                for (const rec of recipients) {
                  const existing = await tx.notification.findFirst({
                    where: {
                      tenantId,
                      staffId: rec.id,
                      kind: 'SYSTEM_AUDIT_OK',
                      resourceType: 'audit_log',
                      readAt: null,
                    },
                  });
                  const data = {
                    tenantId,
                    staffId: rec.id,
                    kind: 'SYSTEM_AUDIT_OK' as const,
                    title: recovered
                      ? 'Audit-Chain mit Recovery-Checkpoint geprueft'
                      : 'Audit-Chain intakt',
                    body: recovered
                      ? `Manuelle Pruefung abgeschlossen: historischer Bruch bleibt abgegrenzt, ${r.checked} Audit-Eintraege geprueft.`
                      : `Manuelle Pruefung abgeschlossen: ${r.checked} Audit-Eintraege und ${r.sealsChecked} Siegel geprueft.`,
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
            }).catch((e) =>
              log.warn(
                { tenantId, err: (e as Error).message },
                'audit-verify: clear-notification failed',
              ),
            );
            results.push({ tenantId, ok: true });
          }
        } catch (err) {
          log.error({ tenantId, err: (err as Error).message }, 'audit-verify: tenant failed');
          results.push({ tenantId, ok: false, broken: 'verify-error' });
          // Auch Lauf-Fehler persistieren — die Admin-Seite soll nicht ewig ein
          // veraltetes „intakt" zeigen, wenn der Check selbst kaputt ist.
          await persistVerifyResult(tenantId, {
            checkedAt: new Date().toISOString(),
            requestId: job.data.requestId ?? null,
            ok: false,
            checked: 0,
            // Anker ERHALTEN, nicht auf null zurücksetzen: `detectTailTruncation`
            // steigt bei fehlendem Vor-Anker kommentarlos aus. Ein einziger
            // fehlgeschlagener Lauf hätte die Tail-Truncation-Erkennung sonst
            // dauerhaft blind gestellt — genau das Fenster, in dem gelöschte
            // Spitzen-Einträge unbemerkt blieben.
            lastAuditId: prev?.lastAuditId ?? null,
            lastAnchorId: prev?.lastAnchorId ?? null,
            lastAnchoredAuditId: prev?.lastAnchoredAuditId ?? null,
            sealsChecked: 0,
            sealBreaks: 0,
            policyBreaks: [],
            firstBreak: null,
            error: (err as Error).message,
            recovered: false,
          }).catch((e) =>
            log.warn({ tenantId, err: (e as Error).message }, 'audit-verify: persist failed'),
          );
        }
      }

    log.info({ results }, 'audit-verify: done');
    return { results };
  },
  { connection, concurrency: 1 },
);

auditVerifyWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'audit-verify: failed');
});
