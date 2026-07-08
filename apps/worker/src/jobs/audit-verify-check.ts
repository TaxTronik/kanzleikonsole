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
  LocalTimestampAdapter,
  createRfc3161Adapter,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  toPersistedVerifyResult,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { withWorkerTenantContext } from '../tenant-context';


// C2: HTTP-Adapter statt Stub — der periodische Verify-Job nutzt
// timestampPort.verify(), das im Stub unbedingt wirft. Bei ENV-only-TSA
// reicht der HTTP-Adapter; Per-Tenant-TSA-Konfiguration (analog
// evidence-seal.ts) ist hier nicht nötig, weil verify() nur den Stamp
// validiert, nicht erneut signiert.
const timestampPort = env.TIMESTAMP_AUTHORITY_URL
  ? createRfc3161Adapter(env.TIMESTAMP_AUTHORITY_URL)
  : new LocalTimestampAdapter();
const evidenceService = new EvidenceService(timestampPort);

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
async function persistVerifyResult(
  tenantId: string,
  result: PersistedVerifyResult,
): Promise<void> {
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
function detectTailTruncation(
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
      ? (async function* () { yield [job.data.tenantId!]; })()
      : await loadTenantIdsChunked();

    for await (const tenantIds of tenantBatches) for (const tenantId of tenantIds) {
      try {
        const checkedAt = new Date();
        // Vorergebnis VOR dem neuen Lauf lesen — liefert den Monotonie-Anker
        // (lastAuditId) für die Tail-Truncation-Erkennung unten.
        const prevRow = await withWorkerTenantContext(tenantId, (tx) =>
          tx.tenantSetting.findUnique({
            where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
          }),
        );
        const prev = (prevRow?.value ?? null) as PersistedVerifyResult | null;

        const r = await prismaOwner.$transaction(
          async (tx) => evidenceService.verifyChain(tx, tenantId, { requireExternalTsa }),
          VERIFY_TX_OPTIONS,
        );

        // M-2/N-3: Monotonie-Anker gegen Tail-Truncation der UNVERSIEGELTEN
        // Spitze. Der Seal-Check oben fängt nur das Löschen VERSIEGELTER Einträge;
        // die neuesten, noch nicht tagesversiegelten Einträge (oder eine komplett
        // geleerte Kette) hinterlassen sonst eine konsistente Kette (ok=true).
        // Nur bei ok=true auswerten: bei einem Bruch ist lastAuditId die letzte
        // GUTE ID (früher Abbruch), kein echter Ketten-Endpunkt.
        const shrinkReason = r.ok ? detectTailTruncation(prev, r.lastAuditId) : null;

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
          recovered = !!(cpRow?.value);
        }

        const effectiveOk = r.ok && !shrinkReason;
        const suppressAlarm = recovered && !shrinkReason;
        const base = toPersistedVerifyResult(r, checkedAt);
        await persistVerifyResult(tenantId, {
          ...base,
          ok: effectiveOk,
          policyBreaks: shrinkReason ? [...base.policyBreaks, shrinkReason] : base.policyBreaks,
          requestId: job.data.requestId ?? null,
          recovered,
        });

        if (!effectiveOk && !suppressAlarm) {
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
                body: r.firstBreak
                  ? `Erster Bruch bei Audit-ID ${r.firstBreak.auditId} (${new Date(r.firstBreak.occurredAt).toISOString()})`
                  : shrinkReason
                    ? shrinkReason
                    : `Verifikation fehlgeschlagen.`,
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
          results.push({ tenantId, ok: false, broken: r.firstBreak ? String(r.firstBreak.auditId) : 'unknown' });
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
                  title: recovered ? 'Audit-Chain mit Recovery-Checkpoint geprueft' : 'Audit-Chain intakt',
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
            log.warn({ tenantId, err: (e as Error).message }, 'audit-verify: clear-notification failed'),
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
          lastAuditId: null,
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
