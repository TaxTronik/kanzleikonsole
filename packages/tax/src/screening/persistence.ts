import type { Prisma } from '@prisma/client';
import { screenEu, type SanctionEntry, type ScreeningSubject } from './core';
type Db = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | 'sanctionsSnapshot' | 'sanctionsSourceState' | 'screeningRun'
>;
export const screeningJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function storeSanctionsSnapshot(
  tx: Db,
  tenantId: string,
  data: {
    sha256: string;
    sourceUrl: string;
    sourceVersion: string;
    publishedAt: Date;
    entries: SanctionEntry[];
  },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eu-source:${tenantId}`},0))`;
  const previous = await tx.sanctionsSourceState.findUnique({
    where: { tenantId },
    include: { snapshot: true },
  });
  if (
    previous?.snapshot &&
    (data.publishedAt < previous.snapshot.publishedAt ||
      data.entries.length < previous.snapshot.entryCount * 0.8)
  )
    throw new Error('EU-Stand älter oder Rückgang über 20 %: Quelle vor Übernahme prüfen.');
  let snapshot = await tx.sanctionsSnapshot.findUnique({
    where: { tenantId_sha256: { tenantId, sha256: data.sha256 } },
  });
  if (!snapshot)
    snapshot = await tx.sanctionsSnapshot.create({
      data: {
        tenantId,
        sha256: data.sha256,
        sourceUrl: data.sourceUrl,
        sourceVersion: data.sourceVersion,
        publishedAt: data.publishedAt,
        entries: screeningJson(data.entries),
        entryCount: data.entries.length,
      },
    });
  await tx.sanctionsSourceState.upsert({
    where: { tenantId },
    create: { tenantId, snapshotId: snapshot.id, checkedAt: new Date(), attemptedAt: new Date() },
    update: {
      snapshotId: snapshot.id,
      checkedAt: new Date(),
      attemptedAt: new Date(),
      lastError: null,
    },
  });
  return { snapshot, changed: previous?.snapshotId !== snapshot.id };
}
/** One immutable follow-up per original subject and source snapshot. Called
 * only in a SYSTEM transaction; STAFF client access remains in the web adapter. */
export async function followupSanctions(
  tx: Db,
  tenantId: string,
  snapshotId: string,
  entries: SanctionEntry[],
  afterId?: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eu-followups:${tenantId}`},0))`;
  const roots = await tx.screeningRun.findMany({
    where: {
      tenantId,
      kind: 'EU',
      previousRunId: null,
      ...(afterId ? { id: { gt: afterId } } : {}),
      client: { mandateEndedAt: null, anonymizedAt: null },
    },
    orderBy: { id: 'asc' },
    take: 10,
  });
  const created: Array<{ id: string; clientId: string; candidates: boolean }> = [];
  for (const original of roots) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gwg-check-lifecycle:${tenantId}:${original.clientId}`},0))`;
    if (original.snapshotId === snapshotId) continue;
    const existing = await tx.screeningRun.findUnique({
      where: { previousRunId_snapshotId: { previousRunId: original.id, snapshotId } },
    });
    if (existing) continue;
    const result = screenEu(original.subject as unknown as ScreeningSubject, entries);
    const run = await tx.screeningRun.create({
      data: {
        tenantId,
        clientId: original.clientId,
        previousRunId: original.id,
        snapshotId,
        kind: 'EU',
        subject: screeningJson(original.subject),
        result: screeningJson(result),
        createdBy: null,
      },
    });
    created.push({ id: run.id, clientId: run.clientId, candidates: result.candidateCount > 0 });
  }
  return { created, nextCursor: roots.length === 10 ? roots[roots.length - 1]!.id : null };
}
