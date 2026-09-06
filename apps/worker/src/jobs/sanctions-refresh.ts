import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { fetchEuSanctions } from '@taxtronik/tax/screening/source';
import { followupSanctions, storeSanctionsSnapshot } from '@taxtronik/tax/screening/persistence';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
const evidence = new EvidenceService(new LocalTimestampAdapter());
/** Daily queue adapter. No network request if every tenant disabled the module.
 * Retries also finish missing follow-ups when a prior job stopped mid-batch. */
export async function runSanctionsRefresh(onlyTenantId?: string) {
  const tenants = await prismaOwner.tenant.findMany({
    where: onlyTenantId ? { id: onlyTenantId } : {},
    select: { id: true },
  });
  const enabled: string[] = [];
  for (const t of tenants)
    if (
      await withWorkerTenantContext(
        t.id,
        async (tx) => (await readBooleanTenantModules(tx, t.id)).sanctionsScreening,
      )
    )
      enabled.push(t.id);
  if (!enabled.length) return { tenants: 0, runs: 0, failed: 0 };
  let downloaded;
  try {
    downloaded = await fetchEuSanctions();
  } catch {
    for (const tenantId of enabled)
      await withWorkerTenantContext(tenantId, async (tx) => {
        await tx.sanctionsSourceState.upsert({
          where: { tenantId },
          create: {
            tenantId,
            attemptedAt: new Date(),
            lastError: 'Täglicher EU-Abruf / Validierung fehlgeschlagen.',
          },
          update: {
            attemptedAt: new Date(),
            lastError: 'Täglicher EU-Abruf / Validierung fehlgeschlagen.',
          },
        });
      });
    throw new Error('EU sanctions refresh failed; last known good snapshots retained.');
  }
  let runs = 0,
    failed = 0;
  for (const tenantId of enabled) {
    try {
      const saved = await withWorkerTenantContext(tenantId, async (tx) => {
        if (!(await readBooleanTenantModules(tx, tenantId)).sanctionsScreening) return null;
        const stored = await storeSanctionsSnapshot(tx, tenantId, downloaded);
        await evidence.record(tx, {
          tenantId,
          actorId: null,
          actorType: 'SYSTEM',
          action: 'screening.source.refresh',
          resourceType: 'sanctions_snapshot',
          resourceId: stored.snapshot.id,
          after: { sha256: stored.snapshot.sha256, changed: stored.changed },
        });
        return stored;
      });
      if (!saved) continue;
      let cursor: string | undefined;
      do {
        const batch = await withWorkerTenantContext(tenantId, async (tx) => {
          if (!(await readBooleanTenantModules(tx, tenantId)).sanctionsScreening)
            return { created: [], nextCursor: null };
          const result = await followupSanctions(
            tx,
            tenantId,
            saved.snapshot.id,
            downloaded.entries,
            cursor,
          );
          const staff = await tx.staffUser.findMany({
            where: {
              tenantId,
              active: true,
              roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
            },
            select: { id: true },
          });
          for (const run of result.created) {
            await evidence.record(tx, {
              tenantId,
              actorId: null,
              actorType: 'SYSTEM',
              action: 'screening.run.followup',
              resourceType: 'screening_run',
              resourceId: run.id,
              after: {
                clientId: run.clientId,
                snapshotId: saved.snapshot.id,
                candidates: run.candidates,
              },
            });
            const recipients = await filterStaffAccessClientTx(
              tx,
              tenantId,
              staff.map((s) => s.id),
              run.clientId,
            );
            for (const staffId of recipients)
              await upsertNotificationTx(tx, {
                tenantId,
                clientId: run.clientId,
                staffId,
                kind: 'SCREENING_REVIEW',
                title: run.candidates
                  ? 'EU-Screening: neue Trefferhinweise prüfen'
                  : 'EU-Screening: neuer Prüflauf zur aktualisierten Liste',
                body: 'Ein neuer unveränderlicher Prüflauf liegt vor. Bestehende GwG-Bewertungen bleiben unverändert.',
                href: `/staff/clients/${run.clientId}/screening`,
                resourceType: 'client',
                resourceId: run.clientId,
              });
          }
          return result;
        });
        runs += batch.created.length;
        cursor = batch.nextCursor ?? undefined;
      } while (cursor);
    } catch {
      failed++;
      await withWorkerTenantContext(tenantId, async (tx) => {
        await tx.sanctionsSourceState.upsert({
          where: { tenantId },
          create: {
            tenantId,
            attemptedAt: new Date(),
            lastError: 'EU-Übernahme oder Folgeprüfungen fehlgeschlagen.',
          },
          update: {
            attemptedAt: new Date(),
            lastError: 'EU-Übernahme oder Folgeprüfungen fehlgeschlagen.',
          },
        });
      });
    }
  }
  if (failed)
    throw new Error(`EU sanctions refresh incomplete for ${failed} tenants; retry required.`);
  return { tenants: enabled.length, runs, failed };
}
