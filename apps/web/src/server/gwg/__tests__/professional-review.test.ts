import { describe, expect, it, vi } from 'vitest';
import {
  isGwgProfessionallyReviewed,
  canStaffReviewGwgTx,
  lockStaffGwgReviewerTx,
  areProfessionalAssigneesEligibleTx,
  type ProfessionalGwgReviewState,
} from '../professional-review';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function reviewed(overrides: Partial<ProfessionalGwgReviewState> = {}): ProfessionalGwgReviewState {
  return {
    status: 'VERIFIED',
    verifiedAt: new Date('2026-07-16T10:00:00.000Z'),
    verifiedBy: 'staff-1',
    reviewSubmittedAt: new Date('2026-07-16T09:00:00.000Z'),
    reviewSubmittedBy: 'staff-2',
    validUntil: new Date('2027-07-16T12:00:00.000Z'),
    ...overrides,
  };
}

describe('isGwgProfessionallyReviewed', () => {
  it('akzeptiert nur den vollständigen, noch gültigen Berufsträger-Review', () => {
    expect(isGwgProfessionallyReviewed(reviewed(), NOW)).toBe(true);
    expect(isGwgProfessionallyReviewed(reviewed({ validUntil: null }), NOW)).toBe(true);
  });

  it.each([
    { status: 'IN_REVIEW' },
    { verifiedAt: null },
    { verifiedBy: null },
    { reviewSubmittedAt: null },
    { reviewSubmittedBy: null },
    { validUntil: new Date('2026-07-16T11:59:59.999Z') },
  ] satisfies Array<Partial<ProfessionalGwgReviewState>>)(
    'lehnt unvollständige oder abgelaufene Nachweise fail-closed ab: %o',
    (override) => {
      expect(isGwgProfessionallyReviewed(reviewed(override), NOW)).toBe(false);
    },
  );

  it('lehnt einen fehlenden Check ab', () => {
    expect(isGwgProfessionallyReviewed(null, NOW)).toBe(false);
  });
});

describe('GWG-RISK-REVIEW-001 / ACCESS-STAFF-PERMISSION-001: current reviewer eligibility', () => {
  it('locks staff, mandate assignment and roles before the fresh eligibility query', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'locked' }]);
    const findFirst = vi.fn().mockResolvedValue({ id: 'assignment' });
    const tx = {
      $queryRaw: queryRaw,
      clientResponsibility: { findFirst },
    } as unknown as Parameters<typeof lockStaffGwgReviewerTx>[0];
    expect(
      await lockStaffGwgReviewerTx(tx, {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
      }),
    ).toBe(true);
    const statements = queryRaw.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(' '),
    );
    expect(statements[0]).toContain('FROM staff_user');
    expect(statements[1]).toContain('FROM client_responsibility');
    expect(statements[1]).toContain("role = 'BERUFSTRAEGER'");
    expect(statements[2]).toContain('FROM staff_role');
    expect(statements.every((statement) => statement.includes('FOR SHARE'))).toBe(true);
    expect(queryRaw.mock.calls[0]!.slice(1)).toEqual(['staff', 'tenant']);
    expect(queryRaw.mock.calls[1]!.slice(1)).toEqual(['tenant', 'client', 'staff']);
    expect(queryRaw.mock.calls[2]!.slice(1)).toEqual(['staff', 'tenant']);
    expect(queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      findFirst.mock.invocationCallOrder[0]!,
    );
    findFirst.mockResolvedValueOnce(null);
    expect(
      await lockStaffGwgReviewerTx(tx, {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
      }),
    ).toBe(false);
  });
  it.each([0, 1, 2])(
    'rejects when lock stage %i finds no remaining row, rather than accepting an unlocked replacement',
    async (missingStage) => {
      const queryRaw = vi.fn();
      for (let index = 0; index < missingStage; index++)
        queryRaw.mockResolvedValueOnce([{ id: 'locked' }]);
      queryRaw.mockResolvedValueOnce([]);
      const findFirst = vi.fn().mockResolvedValue({ id: 'new-unlocked-row' });
      const tx = {
        $queryRaw: queryRaw,
        clientResponsibility: { findFirst },
      } as unknown as Parameters<typeof lockStaffGwgReviewerTx>[0];
      expect(
        await lockStaffGwgReviewerTx(tx, {
          tenantId: 'tenant',
          clientId: 'client',
          staffId: 'staff',
        }),
      ).toBe(false);
      expect(queryRaw).toHaveBeenCalledTimes(missingStage + 1);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
  it('requires active qualification and mandate assignment from one fresh query, without role overrides', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'assignment' });
    const tx = { clientResponsibility: { findFirst } } as unknown as Parameters<
      typeof canStaffReviewGwgTx
    >[0];
    expect(
      await canStaffReviewGwgTx(tx, { tenantId: 'tenant', clientId: 'client', staffId: 'staff' }),
    ).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
        role: 'BERUFSTRAEGER',
        staff: { tenantId: 'tenant', active: true, isProfessional: true, roles: { some: {} } },
      },
      select: { id: true },
    });
    // The same caller is denied after a revoke/deactivation/assignment removal;
    // no prior result or session qualification is cached.
    findFirst.mockResolvedValueOnce(null);
    expect(
      await canStaffReviewGwgTx(tx, { tenantId: 'tenant', clientId: 'client', staffId: 'staff' }),
    ).toBe(false);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
  it('rejects incomplete or empty assignee selections and deduplicates IDs', async () => {
    const count = vi.fn().mockResolvedValue(1);
    const tx = { staffUser: { count } } as unknown as Parameters<
      typeof areProfessionalAssigneesEligibleTx
    >[0];
    expect(await areProfessionalAssigneesEligibleTx(tx, 'tenant', [])).toBe(false);
    expect(count).not.toHaveBeenCalled();
    expect(await areProfessionalAssigneesEligibleTx(tx, 'tenant', ['a', 'a'])).toBe(true);
    expect(await areProfessionalAssigneesEligibleTx(tx, 'tenant', ['a', 'b'])).toBe(false);
    expect(count).toHaveBeenLastCalledWith({
      where: {
        tenantId: 'tenant',
        id: { in: ['a', 'b'] },
        active: true,
        isProfessional: true,
        roles: { some: {} },
      },
    });
  });
});
