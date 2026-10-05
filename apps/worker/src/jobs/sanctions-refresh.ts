// =============================================================================
// sanctions-refresh — täglicher Abruf der EU-Sanktionsliste und Folgeläufe
// (GWG-SCREENING-001).
//
// P-16: Die Aliasliste wird einmal je Lauf vorbereitet (Normalisierung,
// Bigramme) und für alle Tenants verwendet. Folgeläufe entstehen nur für
// Ursprungsläufe, denen der Folgelauf zum aktuellen Stand fehlt — ein
// unveränderter Stand kostet je Tenant eine Abfrage, ein unterbrochener Lauf
// wird beim Retry fortgesetzt. Hinweise je Mandant gibt es nur bei
// Namenskandidaten; Folgeläufe ohne Kandidaten fasst je Tenant und Lauf
// höchstens ein Sammelhinweis an die aktiven ADMIN/PARTNER zusammen. Jeder
// Folgelauf bleibt ein eigener unveränderlicher Nachweis mit Audit-Eintrag.
//
// F-05: Fehler werden protokolliert; der Lauf scheitert, wenn der Abruf oder
// die Übernahme bei einem Tenant scheitert (BullMQ-Retry).
// =============================================================================

import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { prepareEuList, type PreparedEuList } from '@taxtronik/tax';
import { fetchEuSanctions } from '@taxtronik/tax/screening/source';
import { followupSanctions, storeSanctionsSnapshot } from '@taxtronik/tax/screening/persistence';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';

const evidence = new EvidenceService(new LocalTimestampAdapter());

type WorkerTx = Parameters<Parameters<typeof withWorkerTenantContext>[1]>[0];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordSourceFailure(tenantId: string, lastError: string): Promise<void> {
  await withWorkerTenantContext(tenantId, async (tx) => {
    await tx.sanctionsSourceState.upsert({
      where: { tenantId },
      create: { tenantId, attemptedAt: new Date(), lastError },
      update: { attemptedAt: new Date(), lastError },
    });
  });
}

async function activeAdminPartnerIds(tx: WorkerTx, tenantId: string): Promise<string[]> {
  const staff = await tx.staffUser.findMany({
    where: { tenantId, active: true, roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
    select: { id: true },
  });
  return staff.map((entry) => entry.id);
}

/** Folgeläufe eines Tenants in Abschnitten; liefert die Zahl ohne Kandidaten. */
async function runTenantFollowups(
  tenantId: string,
  snapshotId: string,
  prepared: PreparedEuList,
): Promise<{ runs: number; withCandidates: number; withoutCandidates: number }> {
  const counts = { runs: 0, withCandidates: 0, withoutCandidates: 0 };
  let cursor: string | undefined;
  do {
    const batch = await withWorkerTenantContext(tenantId, async (tx) => {
      if (!(await readBooleanTenantModules(tx, tenantId)).sanctionsScreening)
        return { created: [], nextCursor: null };
      const result = await followupSanctions(tx, tenantId, snapshotId, prepared, cursor);
      const admins = result.created.some((run) => run.candidates)
        ? await activeAdminPartnerIds(tx, tenantId)
        : [];
      for (const run of result.created) {
        await evidence.record(tx, {
          tenantId,
          actorId: null,
          actorType: 'SYSTEM',
          action: 'screening.run.followup',
          resourceType: 'screening_run',
          resourceId: run.id,
          after: { clientId: run.clientId, snapshotId, candidates: run.candidates },
        });
        // Nur Namenskandidaten verlangen eine Prüfung je Mandant.
        if (!run.candidates) continue;
        const recipients = await filterStaffAccessClientTx(tx, tenantId, admins, run.clientId);
        for (const staffId of recipients)
          await upsertNotificationTx(tx, {
            tenantId,
            clientId: run.clientId,
            staffId,
            kind: 'SCREENING_REVIEW',
            title: 'EU-Screening: neue Trefferhinweise prüfen',
            body: 'Ein neuer unveränderlicher Prüflauf liegt vor. Bestehende GwG-Bewertungen bleiben unverändert.',
            href: `/staff/clients/${run.clientId}/screening`,
            resourceType: 'client',
            resourceId: run.clientId,
          });
      }
      return result;
    });
    for (const run of batch.created) {
      counts.runs += 1;
      if (run.candidates) counts.withCandidates += 1;
      else counts.withoutCandidates += 1;
    }
    cursor = batch.nextCursor ?? undefined;
  } while (cursor);
  return counts;
}

/** Höchstens ein Sammelhinweis je Tenant und Lauf für Folgeläufe ohne Kandidaten. */
async function notifyFollowupsWithoutCandidates(tenantId: string, count: number): Promise<void> {
  if (count === 0) return;
  await withWorkerTenantContext(tenantId, async (tx) => {
    for (const staffId of await activeAdminPartnerIds(tx, tenantId))
      await upsertNotificationTx(tx, {
        tenantId,
        staffId,
        kind: 'SCREENING_REVIEW',
        title: `EU-Screening: ${count} ${count === 1 ? 'Folgeprüfung' : 'Folgeprüfungen'} ohne Namenshinweis`,
        body: 'Zur aktualisierten EU-Liste liegen neue unveränderliche Prüfläufe ohne Namenskandidaten vor. Bestehende GwG-Bewertungen bleiben unverändert; kein Treffer ist keine Freigabe.',
        href: '/staff/admin/screening',
        resourceType: 'tenant',
        resourceId: tenantId,
      });
  });
}

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
  } catch (err) {
    log.error(
      { component: 'sanctions-refresh', tenants: enabled.length, err: errorMessage(err) },
      'sanctions-refresh: EU-Abruf oder Validierung fehlgeschlagen',
    );
    for (const tenantId of enabled)
      await recordSourceFailure(tenantId, 'Täglicher EU-Abruf / Validierung fehlgeschlagen.');
    throw new Error('EU sanctions refresh failed; last known good snapshots retained.', {
      cause: err,
    });
  }
  const prepared = prepareEuList(downloaded.entries);
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
      const counts = await runTenantFollowups(tenantId, saved.snapshot.id, prepared);
      await notifyFollowupsWithoutCandidates(tenantId, counts.withoutCandidates);
      runs += counts.runs;
      if (counts.runs > 0) {
        log.info(
          { component: 'sanctions-refresh', tenantId, changed: saved.changed, ...counts },
          'sanctions-refresh: Folgeläufe angelegt',
        );
      }
    } catch (err) {
      failed++;
      log.error(
        { component: 'sanctions-refresh', tenantId, err: errorMessage(err) },
        'sanctions-refresh: EU-Übernahme oder Folgeprüfungen fehlgeschlagen',
      );
      await recordSourceFailure(tenantId, 'EU-Übernahme oder Folgeprüfungen fehlgeschlagen.');
    }
  }
  if (failed)
    throw new Error(`EU sanctions refresh incomplete for ${failed} tenants; retry required.`);
  return { tenants: enabled.length, runs, failed };
}
