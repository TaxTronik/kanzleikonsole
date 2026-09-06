import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { sourceIsFresh, SCREENING_ALGORITHM, type ScreeningSubject } from '@taxtronik/tax';
import { ActionError } from '@/server/actions/staff-action';
import {
  gwgProfessionalReviewSnapshotHash,
  type GwgProfessionalReviewSource,
} from '@/server/gwg/review-snapshot';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';

export const SCREENING_GWG_INCLUDE = {
  client: {
    select: {
      id: true,
      kind: true,
      name: true,
      street: true,
      postalCode: true,
      city: true,
      countryIso: true,
    },
  },
  beneficialOwners: true,
  representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  idDocuments: {
    include: {
      document: {
        select: {
          id: true,
          clientId: true,
          classification: true,
          deletedAt: true,
          gwgDestructionRequestedAt: true,
          gwgDestroyedAt: true,
          versions: {
            orderBy: { versionNo: 'desc' },
            take: 1,
            select: { scanStatus: true, scanCompletedAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.GwgCheckInclude;
export type ScreeningTarget = {
  key: string;
  name: string;
  role: string;
  birthDate?: string;
  needsPep: boolean;
};
type Source = Omit<GwgProfessionalReviewSource, 'representatives'> & {
  representatives: Array<
    GwgProfessionalReviewSource['representatives'][number] & {
      birthDate?: Date | string | null;
      isPep?: boolean | null;
    }
  >;
};
export function gwgScreeningContext(check: Source) {
  const date = (value: Date | string | null | undefined) =>
    value ? (value instanceof Date ? value.toISOString() : value).slice(0, 10) : undefined;
  const targets: ScreeningTarget[] = [
    {
      key: `client:${check.clientId}`,
      name: check.client.name,
      role: check.client.kind === 'NATPERS' ? 'Natürlicher Mandant' : 'Mandant / Gesellschaft',
      needsPep: check.client.kind === 'NATPERS',
    },
    ...check.representatives.map((r) => ({
      key: `representative:${r.id}`,
      name: r.fullName,
      role: 'Gesetzliche Vertretung',
      birthDate: date(r.birthDate),
      needsPep: true,
    })),
    ...check.beneficialOwners.map((o) => ({
      key: `owner:${o.id}`,
      name: o.fullName,
      role: 'Wirtschaftlich berechtigte Person',
      birthDate: date(o.birthDate),
      needsPep: true,
    })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const reviewHash = gwgProfessionalReviewSnapshotHash(check);
  const hash = createHash('sha256')
    .update(JSON.stringify({ version: 1, reviewHash, targets }))
    .digest('hex');
  return { checkId: check.id, status: check.status, hash, targets };
}
export async function latestScreeningContextTx(tx: TxClient, tenantId: string, clientId: string) {
  const check = await tx.gwgCheck.findFirst({
    where: { tenantId, clientId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: SCREENING_GWG_INCLUDE,
  });
  return check ? gwgScreeningContext(check) : null;
}
export async function bindScreeningSubjectTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
  subject: ScreeningSubject & { targetKey?: string; contextHash?: string },
) {
  if (!subject.targetKey)
    return {
      name: subject.name,
      role: subject.role,
      ...(subject.birthDate ? { birthDate: subject.birthDate } : {}),
    };
  await lockGwgCheckLifecycleTx(tx, { tenantId, clientId });
  const context = await latestScreeningContextTx(tx, tenantId, clientId);
  if (!context || context.status !== 'IN_REVIEW' || context.hash !== subject.contextHash)
    throw new ActionError(
      'GwG-Fassung ist nicht mehr aktuell oder noch nicht zur Prüfung eingereicht. Seite neu laden und Nachweise an die aktuelle Fassung binden.',
    );
  const target = context.targets.find((t) => t.key === subject.targetKey);
  if (!target) throw new ActionError('Person gehört nicht zur aktuellen GwG-Fassung.');
  return {
    name: target.name,
    role: target.role,
    ...(target.birthDate ? { birthDate: target.birthDate } : {}),
    binding: { checkId: context.checkId, contextHash: context.hash, subjectKey: target.key },
  };
}
type GateRun = {
  id: string;
  kind: string;
  subject: unknown;
  result: unknown;
  snapshotId: string | null;
  reviews: Array<{ outcome: string }>;
};

function boundScreeningRuns(
  runs: GateRun[],
  context: ReturnType<typeof gwgScreeningContext>,
  targetKey: string,
): GateRun[] {
  return runs.filter((run) => {
    const binding = (
      run.subject as { binding?: { checkId?: string; contextHash?: string; subjectKey?: string } }
    )?.binding;
    return (
      binding?.checkId === context.checkId &&
      binding.contextHash === context.hash &&
      binding.subjectKey === targetKey
    );
  });
}

type EuScreeningResult = {
  algorithm?: string;
  status?: string;
  candidateCount?: number;
  truncated?: boolean;
};

function hasValidEuScreeningResult(run: GateRun | undefined, snapshotId: string): boolean {
  const result = run?.result as EuScreeningResult | undefined;
  return Boolean(
    run &&
    run.snapshotId === snapshotId &&
    result?.algorithm === SCREENING_ALGORITHM &&
    ['CANDIDATES', 'NO_NAME_CANDIDATE'].includes(result.status ?? '') &&
    Number.isSafeInteger(result.candidateCount) &&
    (result.candidateCount ?? -1) >= 0 &&
    typeof result.truncated === 'boolean' &&
    (result.status !== 'NO_NAME_CANDIDATE' || result.candidateCount === 0) &&
    (result.status !== 'CANDIDATES' || result.candidateCount !== 0),
  );
}

function hasUnresolvedEuScreeningResult(run: GateRun): boolean {
  const result = run.result as EuScreeningResult;
  const reviewOutcome = run.reviews[0]?.outcome;
  return Boolean(
    result.truncated ||
    (run.reviews.length > 0 && reviewOutcome !== 'FALSE_POSITIVE') ||
    ((result.candidateCount ?? -1) !== 0 && reviewOutcome !== 'FALSE_POSITIVE'),
  );
}

function pepCoverageErrors(check: Source, target: ScreeningTarget, runs: GateRun[]): string[] {
  if (!target.needsPep) return [];
  const errors: string[] = [];
  const pep = runs.find((run) => run.kind === 'PEP');
  const outcome = pep?.reviews[0]?.outcome;
  if (!pep || !['PEP_FOUND', 'PEP_NOT_FOUND'].includes(outcome ?? ''))
    errors.push(`${target.name}: abgeschlossene gebundene PEP-Recherche fehlt.`);
  if (
    outcome === 'PEP_FOUND' &&
    (check.riskLevel !== 'HIGH' ||
      Number((check.riskAnswers as { pep?: number } | null)?.pep ?? 0) < 1)
  )
    errors.push(
      `${target.name}: PEP-Hinweis muss in der GwG-Risikobewertung berücksichtigt und die geänderte Fassung erneut geprüft werden.`,
    );
  return errors;
}

/** Fail closed for incomplete, stale or unresolved coverage. PEP research is
 * evidence, never an automatic change to the existing risk assessment. */
export function screeningCoverageErrors(
  check: Source,
  context: ReturnType<typeof gwgScreeningContext>,
  snapshotId: string,
  runs: GateRun[],
): string[] {
  const errors: string[] = [];
  for (const target of context.targets) {
    const matching = boundScreeningRuns(runs, context, target.key);
    const eu = matching.find((run) => run.kind === 'EU' && run.snapshotId === snapshotId);
    if (!hasValidEuScreeningResult(eu, snapshotId))
      errors.push(`${target.name}: aktueller gebundener EU-Prüflauf fehlt.`);
    else if (hasUnresolvedEuScreeningResult(eu!))
      errors.push(
        `${target.name}: Sanktionshinweise nicht vollständig als andere Identität geklärt.`,
      );
    errors.push(...pepCoverageErrors(check, target, matching));
  }
  return errors;
}
export async function assertGwgScreeningReadyTx(tx: TxClient, tenantId: string, check: Source) {
  // Caller holds the lifecycle lock. Settings/source locks prevent an enable or
  // dataset replacement from overtaking the decision inside this transaction.
  await tx.$queryRaw`SELECT tenant_id FROM tenant_setting WHERE tenant_id=${tenantId}::uuid AND key='modules' FOR SHARE`;
  if (!(await readBooleanTenantModules(tx, tenantId)).sanctionsScreening) return;
  await tx.$queryRaw`SELECT tenant_id FROM sanctions_source_state WHERE tenant_id=${tenantId}::uuid FOR SHARE`;
  const source = await tx.sanctionsSourceState.findUnique({ where: { tenantId } });
  if (!source?.snapshotId || !sourceIsFresh(source.checkedAt, source.lastError))
    throw new ActionError(
      'Screening: aktuelle erfolgreich geprüfte EU-Quelle fehlt. GwG-Freigabe gesperrt.',
    );
  const context = gwgScreeningContext(check);
  const runs = await tx.screeningRun.findMany({
    where: {
      tenantId,
      clientId: check.clientId,
      subject: { path: ['binding', 'contextHash'], equals: context.hash },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1000,
    include: { reviews: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  const errors = screeningCoverageErrors(check, context, source.snapshotId, runs);
  if (errors.length)
    throw new ActionError(`Screening vor GwG-Freigabe vervollständigen: ${errors.join(' ')}`);
}
