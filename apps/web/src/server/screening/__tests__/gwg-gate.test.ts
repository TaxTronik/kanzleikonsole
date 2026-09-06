// Fachkatalog: GWG-SCREENING-001, GWG-RISK-REVIEW-001.
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/server/actions/staff-action', () => ({ ActionError: class extends Error {} }));
vi.mock('@/server/gwg/reverification', () => ({ lockGwgCheckLifecycleTx: vi.fn() }));
import {
  gwgScreeningContext,
  screeningCoverageErrors,
  assertGwgScreeningReadyTx,
  bindScreeningSubjectTx,
} from '../gwg-gate';
import { SCREENING_ALGORITHM } from '@taxtronik/tax';
import type { GwgProfessionalReviewSource } from '@/server/gwg/review-snapshot';
import type { TxClient } from '@taxtronik/db';
const source = (): GwgProfessionalReviewSource => ({
  id: 'check',
  clientId: 'client',
  client: { id: 'client', kind: 'JURPERS', name: 'Example Company' },
  status: 'IN_REVIEW',
  riskLevel: 'LOW',
  riskScore: 0,
  riskAnswers: { pep: 0 },
  notes: null,
  legalForm: 'GmbH',
  registerNumber: 'HRB 1',
  registerAuthority: 'Berlin',
  noRegisterEntry: false,
  representativeNames: ['Representative'],
  representatives: [{ id: 'rep', fullName: 'Representative', position: 1 }],
  ownershipStructureNotes: 'Direct owner',
  beneficialOwners: [
    {
      id: 'owner',
      fullName: 'Owner Name',
      birthDate: '1970-01-01',
      birthPlace: 'Berlin',
      residence: 'Berlin',
      nationality: 'DE',
      ownershipPct: 100,
      isPep: false,
    },
  ],
  idDocuments: [],
  reviewSubmittedAt: '2026-08-31T00:00:00Z',
  reviewSubmittedBy: 'preparer',
});
const complete = (check = source()) => {
  const c = gwgScreeningContext(check);
  return c.targets.flatMap((t) => [
    {
      id: `eu-${t.key}`,
      kind: 'EU',
      snapshotId: 'snapshot',
      subject: { binding: { checkId: c.checkId, contextHash: c.hash, subjectKey: t.key } },
      result: {
        algorithm: SCREENING_ALGORITHM,
        status: 'NO_NAME_CANDIDATE',
        candidateCount: 0,
        truncated: false,
      },
      reviews: [],
    },
    ...(t.needsPep
      ? [
          {
            id: `pep-${t.key}`,
            kind: 'PEP',
            snapshotId: null,
            subject: { binding: { checkId: c.checkId, contextHash: c.hash, subjectKey: t.key } },
            result: {},
            reviews: [{ outcome: 'PEP_NOT_FOUND' }],
          },
        ]
      : []),
  ]);
};
describe('GWG-SCREENING-001 / GWG-RISK-REVIEW-001: current-person decision gate', () => {
  it('requires the company, each representative and each owner with separate person bindings', () => {
    const check = source(),
      context = gwgScreeningContext(check);
    expect(context.targets.map((t) => t.key)).toEqual([
      'client:client',
      'owner:owner',
      'representative:rep',
    ]);
    expect(screeningCoverageErrors(check, context, 'snapshot', [])).toHaveLength(5);
    expect(screeningCoverageErrors(check, context, 'snapshot', complete(check))).toEqual([]);
    expect(
      screeningCoverageErrors(
        check,
        context,
        'snapshot',
        complete(check).filter((r) => r.id !== 'pep-owner:owner'),
      ),
    ).toHaveLength(1);
  });
  it('refuses a renamed person, edited GwG facts, another source and an ad-hoc unbound match', () => {
    const check = source(),
      runs = complete(check);
    check.client.name = 'Other Company';
    expect(
      screeningCoverageErrors(check, gwgScreeningContext(check), 'snapshot', runs),
    ).toHaveLength(5);
    const original = source();
    expect(
      screeningCoverageErrors(
        original,
        gwgScreeningContext(original),
        'new-snapshot',
        complete(original),
      ),
    ).toHaveLength(3);
    const unbound = complete(original).map((r) => ({ ...r, subject: {} }));
    expect(
      screeningCoverageErrors(original, gwgScreeningContext(original), 'snapshot', unbound),
    ).toHaveLength(5);
  });
  it('unresolved/confirmed or truncated candidates block; documented false positive is needed', () => {
    const check = source(),
      context = gwgScreeningContext(check),
      runs = complete(check);
    const eu = runs.find((r) => r.id === 'eu-client:client')!;
    eu.result = {
      algorithm: SCREENING_ALGORITHM,
      status: 'CANDIDATES',
      candidateCount: 1,
      truncated: false,
    };
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
    eu.reviews = [{ outcome: 'CONFIRMED' }];
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
    eu.reviews = [{ outcome: 'FALSE_POSITIVE' }];
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toEqual([]);
    eu.result = { ...eu.result, truncated: true };
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
  });
  it('PEP findings require updated risk facts and repeat evidence for the changed snapshot', () => {
    const check = source(),
      context = gwgScreeningContext(check),
      runs = complete(check);
    runs.find((r) => r.id === 'pep-owner:owner')!.reviews = [{ outcome: 'PEP_FOUND' }];
    expect(screeningCoverageErrors(check, context, 'snapshot', runs).join(' ')).toContain(
      'Risikobewertung',
    );
    check.riskLevel = 'HIGH';
    check.riskAnswers = { pep: 3 };
    expect(gwgScreeningContext(check).hash).not.toBe(context.hash);
    expect(
      screeningCoverageErrors(check, gwgScreeningContext(check), 'snapshot', runs),
    ).toHaveLength(5);
  });
  it('a manual unresolved or confirmed finding blocks even if name matching found no candidate', () => {
    const check = source(),
      context = gwgScreeningContext(check),
      runs = complete(check);
    const eu = runs.find((r) => r.id === 'eu-client:client')!;
    for (const outcome of ['UNRESOLVED', 'CONFIRMED']) {
      eu.reviews = [{ outcome }];
      expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
    }
    eu.reviews = [{ outcome: 'FALSE_POSITIVE' }];
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toEqual([]);
    eu.result = {
      algorithm: SCREENING_ALGORITHM,
      status: 'CANDIDATES',
      candidateCount: 0,
      truncated: false,
    };
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
    eu.result = { algorithm: SCREENING_ALGORITHM, status: 'NO_NAME_CANDIDATE' } as typeof eu.result;
    expect(screeningCoverageErrors(check, context, 'snapshot', runs)).toHaveLength(1);
  });
  it('derives bound identity server-side and refuses stale versions or another person key', async () => {
    const check = source(),
      context = gwgScreeningContext(check);
    const tx = { gwgCheck: { findFirst: vi.fn().mockResolvedValue(check) } };
    const input = {
      name: 'Forged name',
      role: 'Forged role',
      birthDate: '2000-01-01',
      targetKey: 'owner:owner',
      contextHash: context.hash,
    };
    const bound = await bindScreeningSubjectTx(
      tx as unknown as TxClient,
      'tenant',
      'client',
      input,
    );
    expect(bound).toMatchObject({
      name: 'Owner Name',
      role: 'Wirtschaftlich berechtigte Person',
      birthDate: '1970-01-01',
      binding: { checkId: 'check', subjectKey: 'owner:owner', contextHash: context.hash },
    });
    await expect(
      bindScreeningSubjectTx(tx as unknown as TxClient, 'tenant', 'client', {
        ...input,
        targetKey: 'owner:another',
      }),
    ).rejects.toThrow('Person gehört nicht');
    check.notes = 'Facts changed';
    await expect(
      bindScreeningSubjectTx(tx as unknown as TxClient, 'tenant', 'client', input),
    ).rejects.toThrow('nicht mehr aktuell');
  });
  it('disabled module does not query screening data, enabled missing source fails closed', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      tenantSetting: {
        findUnique: vi.fn().mockResolvedValue({ value: { sanctionsScreening: false } }),
      },
      sanctionsSourceState: { findUnique: vi.fn().mockResolvedValue(null) },
      screeningRun: { findMany: vi.fn() },
    };
    await assertGwgScreeningReadyTx(tx as unknown as TxClient, 'tenant', source());
    expect(tx.sanctionsSourceState.findUnique).not.toHaveBeenCalled();
    tx.tenantSetting.findUnique.mockResolvedValue({ value: { sanctionsScreening: true } });
    await expect(
      assertGwgScreeningReadyTx(tx as unknown as TxClient, 'tenant', source()),
    ).rejects.toThrow('Quelle fehlt');
    expect(tx.screeningRun.findMany).not.toHaveBeenCalled();
  });
});
