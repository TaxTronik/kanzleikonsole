import { describe, expect, it } from 'vitest';
import {
  isGwgProfessionallyReviewed,
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
